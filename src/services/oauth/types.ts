export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team' | string
export type RateLimitTier = string
export type BillingType = string

export type OAuthProfileResponse = {
  account: {
    uuid: string
    email: string
    email_address?: string
    display_name?: string | null
    created_at?: string
  }
  organization: {
    uuid: string
    name?: string
    organization_type?: string | null
    rate_limit_tier?: RateLimitTier | null
    has_extra_usage_enabled?: boolean | null
    billing_type?: BillingType | null
    subscription_created_at?: string | null
  }
}

export type OAuthTokenExchangeResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

export type UserRolesResponse = {
  organization_role?: string
  workspace_role?: string
  organization_name?: string
}

export type ReferrerRewardInfo = {
  currency?: string
  amount?: number
  credit_amount?: number
  credit_currency?: string
}

export type ReferralRedemptionsResponse = {
  redemptions?: unknown[]
  referrer_reward?: ReferrerRewardInfo | null
}
