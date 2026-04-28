import axios from 'axios'
import {
  getOauthConfig,
  OAUTH_BETA_HEADER,
  VERBOO_API_BASE_URL,
} from 'src/constants/oauth.js'
import type { OAuthProfileResponse } from 'src/services/oauth/types.js'
import { getAnthropicApiKey } from 'src/utils/auth.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { logError } from 'src/utils/log.js'
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  // Assumes interactive session
  const config = getGlobalConfig()
  const accountUuid = config.oauthAccount?.accountUuid
  const apiKey = getAnthropicApiKey()

  // Need both account UUID and API key to check
  if (!accountUuid || !apiKey) {
    return
  }
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli_profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      params: {
        account_uuid: accountUuid,
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    logError(error as Error)
  }
}

export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  if (getOauthConfig().BASE_API_URL === VERBOO_API_BASE_URL) {
    return getVerbooProfileFromOauthToken(accessToken)
  }

  const endpoint = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    logError(error as Error)
  }
}

type VerbooMeResponse = {
  data?: {
    id: string
    email: string
    name: string
    avatarUrl?: string | null
    confirmed: boolean
  }
}

async function getVerbooProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/me`
  try {
    const response = await axios.get<VerbooMeResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    const user = response.data.data
    if (!user) {
      return
    }

    return {
      account: {
        uuid: user.id,
        email: user.email,
        email_address: user.email,
        display_name: user.name,
      },
      organization: {
        uuid: user.id,
        name: 'Verboo',
        organization_type: 'verboo',
        rate_limit_tier: null,
        has_extra_usage_enabled: null,
        billing_type: null,
        subscription_created_at: undefined,
      },
    }
  } catch (error) {
    logError(error as Error)
  }
}
