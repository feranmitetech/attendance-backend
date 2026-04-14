import { supabase } from '../config/supabase.js'
import { Router } from 'express'
import { authenticate, authorize } from '../middleware/auth.js'

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
router.get('/classes', authenticate, listClasses)
router.post('/classes', authenticate, authorize('admin'), createClass)
router.patch('/classes/:id', authenticate, authorize('admin'), updateClass)
router.delete('/classes/:id', authenticate, authorize('admin'), deleteClass)

// ── Students ──────────────────────────────────────────
router.get('/students', authenticate, listStudents)
router.get('/students/:id', authenticate, getStudent)
router.post('/students', authenticate, authorize('admin'), createStudent)
router.patch('/students/:id', authenticate, authorize('admin'), updateStudent)
router.get('/students/:id/qr', authenticate, getQRCode)
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
router.post('/attendance/checkin', authenticate, checkin)
// Mark all no-shows as absent (admin only, triggered at 8:15 AM)
router.post('/attendance/mark-absent', authenticate, authorize('admin'), markAbsent)
// View records
router.get('/attendance', authenticate, listAttendance)
router.get('/attendance/summary', authenticate, summary)

// SMS logs
router.get('/sms-logs', authenticate, async (req, res) => {
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

  const bcrypt = await import('bcryptjs')
  const passwordHash = await bcrypt.default.hash(password, 12)

  const { data, error } = await supabase
    .from('users')
    .insert({
      school_id: req.user.school_id,
      name,
      email,
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

export default router
