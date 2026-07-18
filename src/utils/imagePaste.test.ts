import { expect, test } from 'bun:test'
import { getClipboardCommands, windowsPathToWsl } from './imagePaste.ts'

// --- windowsPathToWsl -------------------------------------------------------

test('converts backslash Windows paths to /mnt mounts', () => {
  expect(windowsPathToWsl('C:\\Users\\jat\\Pictures\\shot.png')).toBe(
    '/mnt/c/Users/jat/Pictures/shot.png',
  )
})

test('converts forward-slash Windows paths to /mnt mounts', () => {
  expect(windowsPathToWsl('D:/tmp/image.jpg')).toBe('/mnt/d/tmp/image.jpg')
})

test('lowercases the drive letter', () => {
  expect(windowsPathToWsl('C:\\a.png')).toBe('/mnt/c/a.png')
})

test('leaves posix paths unchanged', () => {
  expect(windowsPathToWsl('/home/user/image.png')).toBe(
    '/home/user/image.png',
  )
})

test('leaves relative paths unchanged', () => {
  expect(windowsPathToWsl('image.png')).toBe('image.png')
})

// --- getClipboardCommands (wsl) ---------------------------------------------

test('wsl clipboard commands go through powershell interop', () => {
  const { commands } = getClipboardCommands('wsl')
  expect(commands.checkImage).toContain('powershell')
  expect(commands.checkImage).toContain('Get-Clipboard -Format Image')
  expect(commands.saveImage).toContain('powershell')
  // The PNG is written on the Windows side and copied across via wslpath
  expect(commands.saveImage).toContain('wslpath -u')
  expect(commands.getPath).toContain('Get-Clipboard')
})

test('wsl screenshot path stays on the Linux side for the reader', () => {
  const { screenshotPath } = getClipboardCommands('wsl')
  expect(screenshotPath.startsWith('/')).toBe(true)
})

test('linux clipboard commands are unchanged (xclip/wl-paste)', () => {
  const { commands } = getClipboardCommands('linux')
  expect(commands.checkImage).toContain('xclip')
  expect(commands.saveImage).toContain('wl-paste')
})
