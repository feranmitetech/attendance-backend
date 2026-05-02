import QRCode from 'qrcode'
import { v4 as uuid } from 'uuid'
import { supabase } from '../config/supabase.js'
import { z } from 'zod'

const studentSchema = z.object({
  name: z.string().min(2),
  class_id: z.string().uuid(),
  parent_phone: z.string().min(10),
  photo_url: z.string().url().optional(),
  face_descriptor: z.array(z.number()).optional(), // 128-number array from face-api.js
})

// GET /api/students
// Returns all students for this school (filtered by class if ?class_id=...)
export async function listStudents(req, res) {
  const { class_id, active } = req.query
  const schoolId = req.user.school_id

  let query = supabase
    .from('students')
    .select('*, classes(name, level)')
    .eq('school_id', schoolId)
    .order('name')

  if (class_id) query = query.eq('class_id', class_id)
  if (active !== undefined) query = query.eq('active', active === 'true')

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  return res.json(data)
}

// GET /api/students/:id
export async function getStudent(req, res) {
  const { data, error } = await supabase
    .from('students')
    .select('*, classes(name, level)')
    .eq('id', req.params.id)
    .eq('school_id', req.user.school_id)
    .single()

  if (error || !data) return res.status(404).json({ error: 'Student not found' })
  return res.json(data)
}

// POST /api/students
// Enrolls a new student and generates their QR code
const PLAN_LIMITS = {
  trial:      { students: 50,   staff: 2 },
  starter:    { students: 500,  staff: 3 },
  growth:     { students: 2000, staff: 10 },
  enterprise: { students: Infinity, staff: Infinity },
}

export async function createStudent(req, res) {
  const parsed = studentSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors })
  }

  const schoolId = req.user.school_id

  // Get school plan
  const { data: school } = await supabase
    .from('schools')
    .select('plan')
    .eq('id', schoolId)
    .single()

  const plan = school?.plan || 'trial'
  const limits = PLAN_LIMITS[plan]

  // Count existing active students
  const { count: studentCount } = await supabase
    .from('students')
    .select('*', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('active', true)

  if (studentCount >= limits.students) {
    return res.status(403).json({
      error: 'student_limit_reached',
      message: `Your ${plan} plan allows up to ${limits.students} students. Please upgrade to enroll more students.`,
      limit: limits.students,
      current: studentCount,
    })
  }

  // Continue with enrollment
  const studentCode = generateStudentCode()
  const qrPayload = `${schoolId}:${studentCode}`

  const qrCode = await QRCode.toDataURL(qrPayload, {
    width: 300, margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  })

  const { data, error } = await supabase
    .from('students')
    .insert({
      school_id: schoolId,
      class_id: parsed.data.class_id,
      name: parsed.data.name,
      parent_phone: parsed.data.parent_phone,
      photo_url: parsed.data.photo_url || null,
      face_descriptor: parsed.data.face_descriptor || null,
      student_code: studentCode,
      qr_code: qrPayload,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ ...data, qr_image: qrCode })
}

// PATCH /api/students/:id
// Update student details or save face descriptor after enrollment
export async function updateStudent(req, res) {
  const allowed = ['name', 'class_id', 'parent_phone', 'photo_url', 'face_descriptor', 'active']
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  )

  const { data, error } = await supabase
    .from('students')
    .update(updates)
    .eq('id', req.params.id)
    .eq('school_id', req.user.school_id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
}

// GET /api/students/:id/qr
// Re-generates and returns the QR code image for printing
export async function getQRCode(req, res) {
  const { data: student } = await supabase
    .from('students')
    .select('qr_code, name, student_code')
    .eq('id', req.params.id)
    .eq('school_id', req.user.school_id)
    .single()

  if (!student) return res.status(404).json({ error: 'Student not found' })

  const qrImage = await QRCode.toDataURL(student.qr_code, { width: 400, margin: 2 })

  return res.json({
    name: student.name,
    student_code: student.student_code,
    qr_image: qrImage,
  })
}

// Generates a short readable student code e.g. "STU-7X9K2"
function generateStudentCode() {
  return 'STU-' + uuid().replace(/-/g, '').slice(0, 5).toUpperCase()
}
