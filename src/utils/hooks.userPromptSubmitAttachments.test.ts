import { describe, expect, it } from 'bun:test'
import { buildUserPromptSubmitAttachments } from './hooks.js'
import type { PastedContent } from './config.js'

describe('buildUserPromptSubmitAttachments', () => {
  it('returns undefined when pastedContents is undefined', () => {
    expect(buildUserPromptSubmitAttachments(undefined)).toBeUndefined()
  })

  it('returns undefined when there are no image attachments', () => {
    const pastedContents: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: 'text',
        content: 'some pasted text',
      },
    }
    expect(buildUserPromptSubmitAttachments(pastedContents)).toBeUndefined()
  })

  it('builds base64 attachment from pasted image content', () => {
    const pastedContents: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: 'image',
        content: 'base64data',
        mediaType: 'image/png',
        filename: 'screenshot.png',
      },
    }
    const attachments = buildUserPromptSubmitAttachments(pastedContents)
    expect(attachments).toHaveLength(1)
    expect(attachments![0]).toEqual({
      type: 'image',
      source: 'base64',
      mediaType: 'image/png',
      data: 'base64data',
      path: undefined,
      filename: 'screenshot.png',
    })
  })

  it('builds file attachment when sourcePath is present', () => {
    const pastedContents: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: 'image',
        content: 'base64data',
        mediaType: 'image/jpeg',
        sourcePath: '/tmp/photo.jpg',
        filename: 'photo.jpg',
      },
    }
    const attachments = buildUserPromptSubmitAttachments(pastedContents)
    expect(attachments).toHaveLength(1)
    expect(attachments![0]).toEqual({
      type: 'image',
      source: 'file',
      mediaType: 'image/jpeg',
      data: undefined,
      path: '/tmp/photo.jpg',
      filename: 'photo.jpg',
    })
  })

  it('filters out non-image pasted contents', () => {
    const pastedContents: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: 'text',
        content: 'some text',
      },
      2: {
        id: 2,
        type: 'image',
        content: 'base64data',
        mediaType: 'image/png',
      },
    }
    const attachments = buildUserPromptSubmitAttachments(pastedContents)
    expect(attachments).toHaveLength(1)
    expect(attachments![0].type).toBe('image')
  })

  it('defaults mediaType to image/png when missing', () => {
    const pastedContents: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: 'image',
        content: 'base64data',
      },
    }
    const attachments = buildUserPromptSubmitAttachments(pastedContents)
    expect(attachments![0].mediaType).toBe('image/png')
  })
})
