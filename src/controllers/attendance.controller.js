import { supabase } from '../config/supabase.js'
import { sendAbsenceAlert, sendLateAlert } from '../services/sms.service.js'
import { sendAbsenceAlert, sendLateAlert, sendCheckoutAlert } from '../services/sms.service.js'
import { z } from 'zod'

const checkinSchema = z.object({
  method: z.enum(['qr', 'face', 'manual']),
  // QR check-in: provide qr_code string
  qr_code: z.string().optional(),
  // Face check-in: provide student_id directly (matched on frontend)
  student_id: z.string().uuid().optional(),
  // Manual override: student_id + status
  status: z.enum(['present', 'absent', 'late']).optional(),
})

const checkoutSchema = z.object({
  method: z.enum(['qr', 'face']),
  qr_code: z.string().optional(),
  student_id: z.string().uuid().optional(),
})

// Get current Nigeria time for late check
function getNigeriaTime() {
  return new Date().toLocaleTimeString('en-NG', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Africa/Lagos',
    hour12: false,
  })
}

const LATE_CUTOFF = '08:15:00' // students arriving after this are marked late

// POST /api/attendance/checkin
// Called by the kiosk tablet when a student scans QR or is recognised by face
export async function checkin(req, res) {
  const parsed = checkinSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors })
  }

  const { method, qr_code, student_id, status: manualStatus } = parsed.data
  const schoolId = req.user.school_id
  const today = new Date().toISOString().split('T')[0]
  const now = getNigeriaTime()
  
  // Resolve student from QR code or direct ID
  let student
  if (method === 'qr' && qr_code) {
    const { data } = await supabase
      .from('students')
      .select('id, name, parent_phone, class_id')
      .eq('qr_code', qr_code)
      .eq('school_id', schoolId)
      .eq('active', true)
      .single()
    student = data
  } else if (student_id) {
    const { data } = await supabase
      .from('students')
      .select('id, name, parent_phone, class_id')
      .eq('id', student_id)
      .eq('school_id', schoolId)
      .eq('active', true)
      .single()
    student = data
  }

  if (!student) {
    return res.status(404).json({ error: 'Student not found or not enrolled in this school' })
  }

  // Check if already checked in today
  const { data: existing } = await supabase
    .from('attendance')
    .select('id, status')
    .eq('student_id', student.id)
    .eq('date', today)
    .single()

  if (existing && method !== 'manual') {
    return res.status(409).json({
      error: 'Already checked in today',
      current_status: existing.status,
    })
  }

  // Determine status
  const computedStatus = manualStatus || (now > LATE_CUTOFF ? 'late' : 'present')

  // Upsert attendance (insert or update if manual override)
  const { data: record, error } = await supabase
    .from('attendance')
    .upsert({
      student_id: student.id,
      school_id: schoolId,
      date: today,
      status: computedStatus,
      method,
      check_in_time: now,
      recorded_by: req.user.id,
    }, { onConflict: 'student_id,date' })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Send SMS if late (non-blocking — we don't await this)
  if (computedStatus === 'late') {
  sendLateAlert({ ...student, school_id: schoolId }, now).catch(console.error)
}

  return res.status(201).json({
    student: { id: student.id, name: student.name },
    status: computedStatus,
    check_in_time: now,
    method,
  })
}

// POST /api/attendance/mark-absent
// Called automatically at end of registration window for no-shows
export async function markAbsent(req, res) {
  const schoolId = req.user.school_id
  const today = new Date().toISOString().split('T')[0]

  console.log('markAbsent called for school:', schoolId, 'date:', today)

  const { data: allStudents, error: studentsError } = await supabase
    .from('students')
    .select('id, name, parent_phone')
    .eq('school_id', schoolId)
    .eq('active', true)

  console.log('Students found:', allStudents?.length, studentsError)

  const { data: presentToday, error: attendanceError } = await supabase
    .from('attendance')
    .select('student_id')
    .eq('school_id', schoolId)
    .eq('date', today)

  console.log('Present today:', presentToday?.length, attendanceError)

  const presentIds = new Set(presentToday?.map(r => r.student_id) || [])
  const absentStudents = allStudents?.filter(s => !presentIds.has(s.id)) || []

  console.log('Absent students:', absentStudents.length, absentStudents.map(s => s.name))

  if (absentStudents.length === 0) {
    return res.json({ message: 'All students accounted for', absent_count: 0 })
  }

  const absenceRecords = absentStudents.map(s => ({
    student_id: s.id,
    school_id: schoolId,
    date: today,
    status: 'absent',
    method: 'manual',
    recorded_by: req.user.id,
  }))

  const { error } = await supabase.from('attendance').insert(absenceRecords)
  if (error) return res.status(500).json({ error: error.message })

  await Promise.all(
  absentStudents.map(student =>
    sendAbsenceAlert({ ...student, school_id: schoolId }).catch(console.error)
  )
)

  return res.json({ message: 'Absences recorded', absent_count: absentStudents.length })
}

// GET /api/attendance
// List attendance records — filter by date, class, status
export async function listAttendance(req, res) {
  const { date, class_id, status } = req.query
  const schoolId = req.user.school_id
  const targetDate = date || new Date().toISOString().split('T')[0]

  let query = supabase
    .from('attendance')
    .select('*, students(name, student_code, class_id, classes(name))')
    .eq('school_id', schoolId)
    .eq('date', targetDate)
    .order('check_in_time', { ascending: true })

  if (status) query = query.eq('status', status)

  if (class_id) {
    query = query.eq('students.class_id', class_id)
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  return res.json(data)
}

// GET /api/attendance/summary
// Returns today's counts: present, absent, late, total
export async function summary(req, res) {
  const schoolId = req.user.school_id
  const today = new Date().toISOString().split('T')[0]

  const [{ count: total }, { data: records }] = await Promise.all([
    supabase.from('students').select('*', { count: 'exact', head: true })
      .eq('school_id', schoolId).eq('active', true),
    supabase.from('attendance').select('status')
      .eq('school_id', schoolId).eq('date', today),
  ])

  const counts = { present: 0, absent: 0, late: 0 }
  records?.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++ })

  return res.json({
    date: today,
    total: total || 0,
    ...counts,
    not_yet_recorded: (total || 0) - records?.length,
    percentage: total ? Math.round(((counts.present + counts.late) / total) * 100) : 0,
  })
}

// POST /api/attendance/checkout
// Called by kiosk when student scans QR or is recognised by face on the way out
export async function checkout(req, res) {
  const parsed = checkoutSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten().fieldErrors })
  }

  const { method, qr_code, student_id } = parsed.data
  const schoolId = req.user.school_id
  const today = new Date().toISOString().split('T')[0]
  const now = getNigeriaTime() // reuses your existing helper

  // Resolve student
  let student
  if (method === 'qr' && qr_code) {
    const { data } = await supabase
      .from('students')
      .select('id, name, parent_phone, class_id')
      .eq('qr_code', qr_code)
      .eq('school_id', schoolId)
      .eq('active', true)
      .single()
    student = data
  } else if (student_id) {
    const { data } = await supabase
      .from('students')
      .select('id, name, parent_phone, class_id')
      .eq('id', student_id)
      .eq('school_id', schoolId)
      .eq('active', true)
      .single()
    student = data
  }

  if (!student) {
    return res.status(404).json({ error: 'Student not found or not enrolled in this school' })
  }

  // Must have checked in today before checking out
  const { data: record } = await supabase
    .from('attendance')
    .select('id, status, checked_out, check_out_time')
    .eq('student_id', student.id)
    .eq('date', today)
    .single()

  if (!record) {
    return res.status(409).json({ error: 'Student has not checked in today' })
  }

  if (record.checked_out) {
    return res.status(409).json({
      error: 'Student has already checked out',
      check_out_time: record.check_out_time,
    })
  }

  // Update the existing attendance row with checkout info
  const { data: updated, error } = await supabase
    .from('attendance')
    .update({
      check_out_time: now,
      checked_out: true,
    })
    .eq('id', record.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Always send checkout SMS (non-blocking)
  sendCheckoutAlert({ ...student, school_id: schoolId }, now).catch(console.error)

  return res.status(200).json({
    student: { id: student.id, name: student.name },
    check_out_time: now,
    method,
  })
}
