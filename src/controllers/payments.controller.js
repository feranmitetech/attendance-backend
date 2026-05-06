import { supabase } from '../config/supabase.js'
import crypto from 'crypto'

const PLAN_CODES = {
  starter_monthly: process.env.PAYSTACK_STARTER_PLAN,
  growth_monthly: process.env.PAYSTACK_GROWTH_PLAN,
  enterprise_monthly: process.env.PAYSTACK_ENTERPRISE_PLAN,
  starter_term: process.env.PAYSTACK_STARTER_TERM_PLAN,
  growth_term: process.env.PAYSTACK_GROWTH_TERM_PLAN,
  enterprise_term: process.env.PAYSTACK_ENTERPRISE_TERM_PLAN,
}

const PLAN_NAMES = {
  [process.env.PAYSTACK_STARTER_PLAN]: 'starter',
  [process.env.PAYSTACK_GROWTH_PLAN]: 'growth',
  [process.env.PAYSTACK_ENTERPRISE_PLAN]: 'enterprise',
  [process.env.PAYSTACK_STARTER_TERM_PLAN]: 'starter',
  [process.env.PAYSTACK_GROWTH_TERM_PLAN]: 'growth',
  [process.env.PAYSTACK_ENTERPRISE_TERM_PLAN]: 'enterprise',
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
// Creates a Paystack subscription for the school
export async function initializePayment(req, res) {
  const { plan } = req.body
  const schoolId = req.user.school_id

  if (!PLAN_CODES[plan]) {
    return res.status(400).json({ error: 'Invalid plan selected' })
  }

  // Get school and user details
  const { data: school } = await supabase
    .from('schools')
    .select('name, contact_email, paystack_customer_code')
    .eq('id', schoolId)
    .single()

  if (!school) return res.status(404).json({ error: 'School not found' })

  const email = school.contact_email
  const planCode = PLAN_CODES[plan]

  // Initialize transaction with Paystack
  const response = await paystackRequest('/transaction/initialize', 'POST', {
    email,
    amount: plan === 'starter' ? 1500000 : plan === 'growth' ? 3000000 : 6000000, // in kobo
    plan: planCode,
    metadata: {
      school_id: schoolId,
      school_name: school.name,
      plan,
    },
    callback_url: `${process.env.FRONTEND_URL}/billing/success`,
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
// Called by Paystack when payment events happen
export async function webhook(req, res) {
  // Verify the request is from Paystack
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
    const { metadata, customer, plan } = event.data
    const schoolId = metadata?.school_id
    const planName = PLAN_NAMES[plan?.plan_code] || 'starter'

    if (!schoolId) return res.sendStatus(200)

    // Activate the school's subscription
    const subscriptionEnd = new Date()
    subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1)

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

    console.log(`School ${schoolId} activated on ${planName} plan`)
  }

  if (event.event === 'subscription.disable' || event.event === 'invoice.payment_failed') {
    const schoolId = event.data?.metadata?.school_id
    if (!schoolId) return res.sendStatus(200)

    // Give 3 day grace period
    const graceEnd = new Date()
    graceEnd.setDate(graceEnd.getDate() + 3)

    await supabase
      .from('schools')
      .update({
        status: 'trial',
        trial_ends_at: graceEnd.toISOString(),
      })
      .eq('id', schoolId)

    console.log(`School ${schoolId} subscription failed — grace period started`)
  }

  return res.sendStatus(200)
}

// GET /api/payments/status
// Returns current subscription status for the school
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

  return res.json({
    plan: school.plan || 'trial',
    status: school.status || 'trial',
    trial_days_left: trialDaysLeft,
    subscription_end_at: school.subscription_end_at,
    billing_email: school.billing_email,
  })
}

// POST /api/payments/cancel
// Cancels the school's Paystack subscription
export async function cancelSubscription(req, res) {
  const { data: school } = await supabase
    .from('schools')
    .select('paystack_subscription_code')
    .eq('id', req.user.school_id)
    .single()

  if (school?.paystack_subscription_code) {
    await paystackRequest(
      `/subscription/disable`,
      'POST',
      {
        code: school.paystack_subscription_code,
        token: school.paystack_subscription_code,
      }
    )
  }

  return res.json({ message: 'Subscription cancelled' })
}
