import { expect, test } from 'bun:test'

import { VerbooApiError } from '../api/verbooApiError.js'
import { describePurchaseError } from './purchaseErrors.js'

test('keeps a 403 business error instead of reporting an expired session', () => {
  const error = new VerbooApiError({
    message: 'restricted',
    kind: 'http',
    status: 403,
    code: 'waitlist_subscribers_only',
  })

  expect(describePurchaseError(error, 'fallback').message).toContain(
    'lista de espera',
  )
})

test('uses session guidance for an unclassified authorization failure', () => {
  const error = new VerbooApiError({
    message: 'forbidden',
    kind: 'http',
    status: 403,
  })

  expect(describePurchaseError(error, 'fallback').message).toContain(
    'Entre novamente',
  )
})
