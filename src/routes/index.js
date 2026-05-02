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
router.post('/users', authenticate, authorize('admin'), async (req, res) => {
  const { name, email, password, role } = req.body
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' })
  }

  const STAFF_LIMITS = {
    trial: 2, starter: 3, growth: 10, enterprise: Infinity
  }

  // Get school plan
  const { data: school } = await supabase
    .from('schools')
    .select('plan')
    .eq('id', req.user.school_id)
    .single()

  const plan = school?.plan || 'trial'
  const limit = STAFF_LIMITS[plan]

  // Count existing staff
  const { count: staffCount } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('school_id', req.user.school_id)
    .neq('id', req.user.id) // exclude the admin themselves

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

export default router
