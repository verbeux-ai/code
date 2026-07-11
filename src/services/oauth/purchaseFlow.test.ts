import { expect, test } from 'bun:test'

import { isValidCPF, onlyDigits } from './purchaseValidation.js'

test('validates CPF with its check digits', () => {
  expect(isValidCPF('529.982.247-25')).toBe(true)
  expect(isValidCPF('529.982.247-24')).toBe(false)
  expect(isValidCPF('111.111.111-11')).toBe(false)
})

test('removes display formatting before submitting payer data', () => {
  expect(onlyDigits('(11) 99999-9999')).toBe('11999999999')
  expect(onlyDigits('529.982.247-25')).toBe('52998224725')
})
