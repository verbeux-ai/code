import type { LocalCommandCall } from '../../types/command.js'

const messages = [
  "You're almost reaching your limit. Try a little more.",
  "You're almost at your usage limit. Push a bit further and see what happens.",
  "Heads up — you're approaching your limit. Just one more prompt should do it.",
  "Warning: you're getting close to your usage cap. Keep going, we dare you.",
  "You've used 99% of your quota. One more prompt won't hurt.",
  "Critical: usage spike detected. Carry on, see what breaks.",
  "Looks like you're running low on tokens. Try anyway, just in case.",
  "Approaching limit. Probably best to keep going.",
  "You're nearly out of usage. Send another prompt — for science.",
  "Limit incoming. Maybe slow down. Or don't.",
]

export const call: LocalCommandCall = async () => {
  return {
    type: 'text',
    value: messages[Math.floor(Math.random() * messages.length)],
  }
}
