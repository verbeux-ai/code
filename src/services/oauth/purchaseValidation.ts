export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}

export function isValidCPF(value: string): boolean {
  const cpf = onlyDigits(value)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false

  const digit = (length: number): number => {
    let total = 0
    for (let index = 0; index < length; index += 1) {
      total += Number(cpf[index]) * (length + 1 - index)
    }
    const remainder = (total * 10) % 11
    return remainder === 10 ? 0 : remainder
  }

  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10])
}
