import 'dotenv/config'
import { supabase } from '../config/supabase.js'

function formatPhone(phone) {
  const clean = phone.replace(/\s+/g, '').replace(/^0/, '')
  return clean.startsWith('+') ? clean.replace('+', '') : `234${clean}`
}

async function sendSMS(student, message) {
  console.log('Sender ID being used:', process.env.TERMII_SENDER_ID)
  const recipient = formatPhone(student.parent_phone)

  // Insert log first and get its ID
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
    const response = await fetch('https://v3.api.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: recipient,
        from: process.env.TERMII_SENDER_ID,
        sms: message,
        type: 'plain',
        channel: 'generic',
        api_key: process.env.TERMII_API_KEY,
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
      await supabase
        .from('sms_logs')
        .update({ status: 'failed' })
        .eq('id', logRow.id)
    }
    console.error(`SMS failed for ${student.name}:`, err.message)
  }
}

export async function sendAbsenceAlert(student) {
  const today = new Date().toLocaleDateString('en-NG', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  const message =
    `Dear Parent, your ward ${student.name} was absent from school today, ${today}. ` +
    `Please contact the school if this is unexpected. Thank you.`
  return sendSMS(student, message)
}

export async function sendLateAlert(student, time) {
  const displayTime = time.slice(0, 5)
  const today = new Date().toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
  const message =
    `Dear Parent, your ward ${student.name} arrived late at school at ${displayTime} on ${today}. ` +
    `Please ensure timely arrival. Thank you.`
  return sendSMS(student, message)
}

export async function sendCustomAlert(student, message) {
  return sendSMS(student, message)
}