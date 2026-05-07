import 'dotenv/config'
import { supabase } from '../config/supabase.js'

function formatPhone(phone) {
  const clean = phone.replace(/\s+/g, '').replace(/^0/, '')
  return clean.startsWith('+') ? clean.replace('+', '') : `234${clean}`
}

async function getSchoolSMSConfig(schoolId) {
  const { data } = await supabase
    .from('schools')
    .select('termii_api_key, termii_sender_id')
    .eq('id', schoolId)
    .single()
  return data
}

async function sendSMS(student, message) {
  const recipient = formatPhone(student.parent_phone)

  const { data: logRow } = await supabase
    .from('sms_logs')
    .insert({
      student_id: student.id,
      school_id: student.school_id,
      recipient_phone: recipient,
      message,
      status: 'pending',
    })
    .select()
    .single()

  try {
    // Get this school's own Termii credentials
    const config = await getSchoolSMSConfig(student.school_id)

    if (!config?.termii_api_key || !config?.termii_sender_id) {
      console.log(`SMS skipped for ${student.name} — school has not configured SMS settings`)
      if (logRow) {
        await supabase.from('sms_logs').update({ status: 'not_configured' }).eq('id', logRow.id)
      }
      return
    }

    const response = await fetch('https://v3.api.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: recipient,
        from: config.termii_sender_id,
        sms: message,
        type: 'plain',
        channel: 'generic',
        api_key: config.termii_api_key,
      }),
    })

    const data = await response.json()
    console.log(`SMS to ${student.name} (${recipient}):`, data.message || data.code)

    const success = response.ok && data.message_id
    if (logRow) {
      await supabase
        .from('sms_logs')
        .update({ status: success ? 'delivered' : 'failed' })
        .eq('id', logRow.id)
    }

  } catch (err) {
    if (logRow) {
      await supabase.from('sms_logs').update({ status: 'failed' }).eq('id', logRow.id)
    }
    console.error(`SMS failed for ${student.name}:`, err.message)
  }
}

export async function sendAbsenceAlert(student) {
  const today = new Date().toLocaleDateString('en-NG', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Africa/Lagos',
  })
  const message =
    `Dear Parent, your ward ${student.name} was absent from school today, ${today}. ` +
    `Please contact the school if this is unexpected. Thank you.`
  return sendSMS(student, message)
}

export async function sendLateAlert(student, time) {
  const nigeriaTime = new Date().toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
    hour12: false,
  })
  const today = new Date().toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Africa/Lagos',
  })
  const message =
    `Dear Parent, your ward ${student.name} arrived late at school at ${nigeriaTime} on ${today}. ` +
    `Please ensure timely arrival. Thank you.`
  return sendSMS(student, message)
}

export async function sendCheckoutAlert(student, checkOutTime) {
  const { data: school } = await supabase
    .from('schools')
    .select('termii_api_key, termii_sender_id, name')
    .eq('id', student.school_id)
    .single()

  if (!school?.termii_api_key) return

  const message = `AttendEase: ${student.name} has left school at ${checkOutTime}. If this was unexpected, please contact the school immediately.`

  await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: student.parent_phone,
      from: school.termii_sender_id || 'AttendEase',
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: school.termii_api_key,
    }),
  })
}

export async function sendCustomAlert(student, message) {
  return sendSMS(student, message)
}
