import { supabase } from '../config/supabase.js'
import crypto from 'crypto'

const PLAN_AMOUNTS = {
  starter_monthly: 1500000,
  growth_monthly: 3000000,
  enterprise_monthly: 6000000,
  starter_term: 3825000,
  growth_term: 7650000,
  enterprise_term: 15300000,
}

const PLAN_DURATIONS = {
  starter_monthly: 30,
  growth_monthly: 30,
  enterprise_monthly: 30,
  starter_term: 105,
  growth_term: 105,
  enterprise_term: 105,
}

const PLAN_NAMES = {
  starter_monthly: 'starter',
  growth_monthly: 'growth',
  enterprise_monthly: 'enterprise',
  starter_term: 'starter',
  growth_term: 'growth',
  enterprise_term: 'enterprise',
}

async function paystackRequest(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  })
  return res.json()
}

// POST /api/payments/initialize
export async function initializePayment(req, res) {
  const { plan } = req.body
  const schoolId = req.user.school_id

  if (!PLAN_AMOUNTS[plan]) {
    return res.status(400).json({ error: 'Invalid plan selected' })
  }

  const { data: school } = await supabase
    .from('schools')
    .select('name, contact_email')
    .eq('id', schoolId)
    .single()

  if (!school) return res.status(404).json({ error: 'School not found' })

  // Generate unique reference
  const reference = `ATT-${schoolId.slice(0, 8)}-${Date.now()}`

  // Initialize one-time transaction — no plan/subscription
  const response = await paystackRequest('/transaction/initialize', 'POST', {
    email: school.contact_email,
    amount: PLAN_AMOUNTS[plan],
    reference,
    metadata: {
      school_id: schoolId,
      school_name: school.name,
      plan,
      duration_days: PLAN_DURATIONS[plan],
    },
    callback_url: `${process.env.FRONTEND_URL}/billing/success?reference=${reference}`,
  })

  if (!response.status) {
    return res.status(500).json({ error: 'Failed to initialize payment' })
  }

  return res.json({
    authorization_url: response.data.authorization_url,
    reference: response.data.reference,
  })
}

// POST /api/payments/webhook
export async function webhook(req, res) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex')

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const event = req.body
  console.log('Paystack webhook event:', event.event)

  if (event.event === 'charge.success') {
    const { metadata, customer } = event.data
    const schoolId = metadata?.school_id
    const plan = metadata?.plan
    const durationDays = metadata?.duration_days || 30

    if (!schoolId || !plan) return res.sendStatus(200)

    const planName = PLAN_NAMES[plan] || 'starter'

    // Calculate subscription end date
    const subscriptionEnd = new Date()
    subscriptionEnd.setDate(subscriptionEnd.getDate() + durationDays)

    await supabase
      .from('schools')
      .update({
        plan: planName,
        status: 'active',
        paystack_customer_code: customer?.customer_code,
        subscription_start_at: new Date().toISOString(),
        subscription_end_at: subscriptionEnd.toISOString(),
        trial_ends_at: null,
        billing_email: customer?.email,
      })
      .eq('id', schoolId)

    console.log(`School ${schoolId} activated on ${planName} plan for ${durationDays} days`)
  }

  return res.sendStatus(200)
}

// GET /api/payments/status
export async function getStatus(req, res) {
  const { data: school } = await supabase
    .from('schools')
    .select('plan, status, trial_ends_at, subscription_end_at, billing_email')
    .eq('id', req.user.school_id)
    .single()

  if (!school) return res.status(404).json({ error: 'School not found' })

  const trialDaysLeft = school.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(school.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
    : 0

  const subscriptionDaysLeft = school.subscription_end_at
    ? Math.max(0, Math.ceil((new Date(school.subscription_end_at) - new Date()) / (1000 * 60 * 60 * 24)))
    : 0

  return res.json({
    plan: school.plan || 'trial',
    status: school.status || 'trial',
    trial_days_left: trialDaysLeft,
    subscription_days_left: subscriptionDaysLeft,
    subscription_end_at: school.subscription_end_at,
    billing_email: school.billing_email,
  })
}

// POST /api/payments/verify
// Called after redirect from Paystack to verify payment
export async function verifyPayment(req, res) {
  const { reference } = req.body

  if (!reference) return res.status(400).json({ error: 'Reference is required' })

  const response = await paystackRequest(`/transaction/verify/${reference}`)

  if (!response.status || response.data?.status !== 'success') {
    return res.status(400).json({ error: 'Payment not successful' })
  }

  const { metadata, customer } = response.data
  const schoolId = metadata?.school_id
  const plan = metadata?.plan
  const durationDays = metadata?.duration_days || 30

  if (!schoolId) return res.status(400).json({ error: 'Invalid payment metadata' })

  const planName = PLAN_NAMES[plan] || 'starter'
  const subscriptionEnd = new Date()
  subscriptionEnd.setDate(subscriptionEnd.getDate() + durationDays)

  await supabase
    .from('schools')
    .update({
      plan: planName,
      status: 'active',
      paystack_customer_code: customer?.customer_code,
      subscription_start_at: new Date().toISOString(),
      subscription_end_at: subscriptionEnd.toISOString(),
      trial_ends_at: null,
      billing_email: customer?.email,
    })
    .eq('id', schoolId)

  return res.json({
    message: 'Payment verified and subscription activated',
    plan: planName,
    subscription_end_at: subscriptionEnd.toISOString(),
  })
}

export async function cancelSubscription(req, res) {
  return res.json({ message: 'Subscription cancelled' })
}
