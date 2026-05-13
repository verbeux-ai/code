import { useState } from 'react'
import { major, minor, patch } from 'semver'

export function getSemverPart(version: string): string {
  return `${major(version, { loose: true })}.${minor(version, { loose: true })}.${patch(version, { loose: true })}`
}

export function shouldShowUpdateNotification(
  updatedVersion: string,
  lastNotifiedSemver: string | null,
): boolean {
  const updatedSemver = getSemverPart(updatedVersion)
  return updatedSemver !== lastNotifiedSemver
}

export function useUpdateNotification(
  updatedVersion: string | null | undefined,
  initialVersion: string = MACRO.DISPLAY_VERSION,
): string | null {
  // Bug fix: o padrão original era "setState during render + derivar retorno
  // da comparação" — React descarta o JSX da primeira passada e re-renderiza
  // com o novo state. Na 2ª passada lastNotifiedSemver === updatedSemver,
  // retornava null, e o commit ficava com null. Resultado: a notificação
  // de update nunca aparecia.
  // Fix: armazenar o valor da notificação em state separado para que persista
  // através do re-render. Também troca default de MACRO.VERSION (= '99.0.0'
  // hardcoded em verboo p/ bypassar version gate) para MACRO.DISPLAY_VERSION
  // (versão real em execução).
  const [lastNotifiedSemver, setLastNotifiedSemver] = useState<string | null>(
    () => getSemverPart(initialVersion),
  )
  const [pendingNotification, setPendingNotification] = useState<string | null>(
    null,
  )

  if (updatedVersion) {
    const updatedSemver = getSemverPart(updatedVersion)
    if (updatedSemver !== lastNotifiedSemver) {
      setLastNotifiedSemver(updatedSemver)
      setPendingNotification(updatedSemver)
    }
  }

  return pendingNotification
}
