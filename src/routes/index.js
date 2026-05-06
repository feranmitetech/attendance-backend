import express from 'express'
import { initializePayment, webhook, getStatus, cancelSubscription } from '../controllers/payments.controller.js'
import { supabase } from '../config/supabase.js'
import { Router } from 'express'
import { authenticate, authorize, checkSubscription } from '../middleware/auth.js'

import { register, login, me } from '../controllers/auth.controller.js'
import { listStudents, getStudent, createStudent, updateStudent, getQRCode } from '../controllers/students.controller.js'
import { checkin, markAbsent, listAttendance, summary } from '../controllers/attendance.controller.js'
import { listClasses, createClass, updateClass, deleteClass } from '../controllers/classes.controller.js'

const router = Router()

// ── Auth (public) ─────────────────────────────────────
router.post('/auth/register', register)
router.post('/auth/login', login)
router.get('/auth/me', authenticate, me)

// ── Classes ───────────────────────────────────────────
router.get('/classes', authenticate, checkSubscription, listClasses)
router.post('/classes', authenticate, checkSubscription, authorize('admin'), createClass)
router.patch('/classes/:id', authenticate, checkSubscription, authorize('admin'), updateClass)
router.delete('/classes/:id', authenticate, checkSubscription, authorize('admin'), deleteClass)

// ── Students ──────────────────────────────────────────
router.get('/students', authenticate, checkSubscription, listStudents)
router.get('/students/:id', authenticate, checkSubscription, getStudent)
router.post('/students', authenticate, checkSubscription, authorize('admin'), createStudent)
router.patch('/students/:id', authenticate, checkSubscription, authorize('admin'), updateStudent)
router.get('/students/:id/qr', authenticate, checkSubscription, getQRCode)
router.delete('/students/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    console.log('Deleting student:', req.params.id, 'for school:', req.user.school_id)
    
    // First delete attendance records for this student
    await supabase
      .from('attendance')
      .delete()
      .eq('student_id', req.params.id)

    // Then delete sms logs
    await supabase
      .from('sms_logs')
      .delete()
      .eq('student_id', req.params.id)

    // Finally delete the student
    const { error } = await supabase
      .from('students')
      .delete()
      .eq('id', req.params.id)
      .eq('school_id', req.user.school_id)

    if (error) {
      console.error('Delete error:', error)
      return res.status(500).json({ error: error.message })
    }

    console.log('Student deleted successfully')
    return res.json({ message: 'Student permanently deleted' })
  } catch (err) {
    console.error('Unexpected error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── Attendance ────────────────────────────────────────
// Kiosk check-in (admin + teacher can trigger)
router.post('/attendance/checkin', authenticate, checkSubscription, checkin)
// Mark all no-shows as absent (admin only, triggered at 8:15 AM)
router.post('/attendance/mark-absent', authenticate, checkSubscription, authorize('admin'), markAbsent)
// View records
router.get('/attendance', authenticate, checkSubscription, listAttendance)
router.get('/attendance/summary', authenticate, checkSubscription, summary)

// SMS logs
router.get('/sms-logs', authenticate, checkSubscription, async (req, res) => {
  const { data, error } = await supabase
    .from('sms_logs')
    .select('*, students(name)')
    .eq('school_id', req.user.school_id)
    .order('sent_at', { ascending: false })
    .limit(100)

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

// ── Users / Teachers ──────────────────────────────────
router.get('/users', authenticate, authorize('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, created_at')
    .eq('school_id', req.user.school_id)
    .order('name')

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

router.post('/users', authenticate, authorize('admin'), async (req, res) => {
  const { name, email, password, role } = req.body
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' })
  }

  const STAFF_LIMITS = {
    trial: 2, starter: 3, growth: 10, enterprise: Infinity
  }

  const { data: school } = await supabase
    .from('schools')
    .select('plan')
    .eq('id', req.user.school_id)
    .single()

  const plan = school?.plan || 'trial'
  const limit = STAFF_LIMITS[plan]

  const { count: staffCount } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('school_id', req.user.school_id)
    .neq('id', req.user.id)

  if (staffCount >= limit) {
    return res.status(403).json({
      error: 'staff_limit_reached',
      message: `Your ${plan} plan allows up to ${limit} staff accounts. Please upgrade to add more.`,
      limit,
      current: staffCount,
    })
  }

  const bcrypt = await import('bcryptjs')
  const passwordHash = await bcrypt.default.hash(password, 12)

  const { data, error } = await supabase
    .from('users')
    .insert({
      school_id: req.user.school_id,
      name, email,
      password_hash: passwordHash,
      role: role || 'teacher',
    })
    .select('id, name, email, role')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json(data)
})

router.delete('/users/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await supabase
      .from('classes')
      .update({ teacher_id: null })
      .eq('teacher_id', req.params.id)
      .eq('school_id', req.user.school_id)

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.params.id)
      .eq('school_id', req.user.school_id)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ message: 'User removed' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

router.delete('/users/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    // First unassign teacher from any classes they teach
    await supabase
      .from('classes')
      .update({ teacher_id: null })
      .eq('teacher_id', req.params.id)
      .eq('school_id', req.user.school_id)

    // Then delete the user
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.params.id)
      .eq('school_id', req.user.school_id)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ message: 'User removed' })
  } catch (err) {
    console.error('Delete user error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── School settings ───────────────────────────────────
router.get('/settings', authenticate, authorize('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('schools')
    .select('name, subdomain, contact_email, termii_api_key, termii_sender_id, trial_ends_at, status')
    .eq('id', req.user.school_id)
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

router.patch('/settings', authenticate, authorize('admin'), async (req, res) => {
  const allowed = ['termii_api_key', 'termii_sender_id', 'name', 'contact_email']
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  )

  const { data, error } = await supabase
    .from('schools')
    .update(updates)
    .eq('id', req.user.school_id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

// ── Payments ──────────────────────────────────────────
// Webhook must use raw body — add before other payment routes
router.post('/payments/webhook', express.raw({ type: 'application/json' }), webhook)
router.post('/payments/initialize', authenticate, checkSubscription, initializePayment)
router.get('/payments/status', authenticate, getStatus)
router.post('/payments/cancel', authenticate, authorize('admin'), cancelSubscription)

// ── Staff attendance ──────────────────────────────────
router.post('/staff/checkin', authenticate, async (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  const now = new Date().toLocaleTimeString('en-NG', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Africa/Lagos', hour12: false,
  })

  // Check if already checked in
  const { data: existing } = await supabase
    .from('staff_attendance')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .single()

  if (existing) {
    return res.status(409).json({ error: 'Already checked in today' })
  }

  const { error } = await supabase
    .from('staff_attendance')
    .insert({
      user_id: req.user.id,
      school_id: req.user.school_id,
      date: today,
      check_in_time: now,
      status: 'present',
    })

  if (error) return res.status(500).json({ error: error.message })

  return res.json({
    message: 'Checked in successfully',
    name: req.user.name,
    time: now,
  })
})

router.get('/staff/attendance', authenticate, async (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  const { date } = req.query
  const targetDate = date || today

  const { data, error } = await supabase
    .from('staff_attendance')
    .select('*, users(name, email, role)')
    .eq('school_id', req.user.school_id)
    .eq('date', targetDate)
    .order('check_in_time', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

// Change password
router.patch('/auth/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required' })
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' })
  }

  // Get user with password hash
  const { data: user } = await supabase
    .from('users')
    .select('password_hash')
    .eq('id', req.user.id)
    .single()

  if (!user) return res.status(404).json({ error: 'User not found' })

  // Verify current password
  const bcrypt = await import('bcryptjs')
  const valid = await bcrypt.default.compare(current_password, user.password_hash)

  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' })
  }

  // Hash new password
  const newHash = await bcrypt.default.hash(new_password, 12)

  await supabase
    .from('users')
    .update({ password_hash: newHash })
    .eq('id', req.user.id)

  return res.json({ message: 'Password changed successfully' })
})

// Forgot password — sends reset email
router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email is required' })

  // Check if user exists
  const { data: user } = await supabase
    .from('users')
    .select('id, name, email')
    .eq('email', email)
    .single()

  // Always return success even if email not found (security best practice)
  if (!user) return res.json({ message: 'If this email exists you will receive a reset link' })

  // Generate reset token
  const { randomBytes } = await import('crypto')
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // Store token
  await supabase.from('password_resets').insert({
    email,
    token,
    expires_at: expiresAt.toISOString(),
  })

  // Send reset email via fetch to a simple email service
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`

  console.log(`Password reset link for ${email}: ${resetUrl}`)

  // For now log the URL — we'll add email sending next
  // TODO: Send email with resetUrl

  return res.json({ message: 'If this email exists you will receive a reset link', resetUrl })
})

// Reset password with token
router.post('/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body

  if (!token || !new_password) {
    return res.status(400).json({ error: 'Token and new password are required' })
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  // Find valid token
  const { data: reset } = await supabase
    .from('password_resets')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single()

  if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link' })

  if (new Date() > new Date(reset.expires_at)) {
    return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' })
  }

  // Find user
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('email', reset.email)
    .single()

  if (!user) return res.status(404).json({ error: 'User not found' })

  // Update password
  const bcrypt = await import('bcryptjs')
  const newHash = await bcrypt.default.hash(new_password, 12)

  await supabase
    .from('users')
    .update({ password_hash: newHash })
    .eq('id', user.id)

  // Mark token as used
  await supabase
    .from('password_resets')
    .update({ used: true })
    .eq('token', token)

  return res.json({ message: 'Password reset successfully. You can now log in.' })
})

export default router
