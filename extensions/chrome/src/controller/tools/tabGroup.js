/**
 * tabGroup.js — tab group management: create, remove, assign, unassign.
 *
 * Uses chrome.tabGroups + chrome.tabs.group (no debugger). Tab groups
 * are per-window; we operate on the current window.
 *
 * @param {{ name: 'tab_group'; action: 'create' | 'remove' | 'assign' | 'unassign'; groupId?: number; tabIds?: number[]; title?: string; color?: string; risk?: string; input?: string }} tool
 * @returns {Promise<unknown>}
 */
export async function tabGroup(tool) {
  const action = tool?.action
  switch (action) {
    case 'create': {
      const tabIds = Array.isArray(tool.tabIds) ? tool.tabIds : []
      if (tabIds.length === 0) throw new Error('tab_group.create: missing tabIds')
      const groupId = await chrome.tabs.group({ tabIds })
      if (tool.title || tool.color) {
        const update = {}
        if (tool.title) update.title = tool.title
        if (tool.color) update.color = tool.color
        await chrome.tabGroups.update(groupId, update)
      }
      return { groupId, tabIds }
    }
    case 'remove': {
      if (typeof tool.groupId !== 'number') throw new Error('tab_group.remove: missing groupId')
      await chrome.tabGroups.ungroup(tool.groupId)
      return { groupId: tool.groupId, removed: true }
    }
    case 'assign': {
      const tabIds = Array.isArray(tool.tabIds) ? tool.tabIds : []
      if (tabIds.length === 0) throw new Error('tab_group.assign: missing tabIds')
      if (typeof tool.groupId !== 'number') throw new Error('tab_group.assign: missing groupId')
      const groupId = await chrome.tabs.group({ groupId: tool.groupId, tabIds })
      return { groupId, tabIds }
    }
    case 'unassign': {
      const tabIds = Array.isArray(tool.tabIds) ? tool.tabIds : []
      if (tabIds.length === 0) throw new Error('tab_group.unassign: missing tabIds')
      // Ungroup specific tabs by passing them to tabs.group with create
      // (a new group) then immediately ungrouping — but the simpler API
      // is chrome.tabs.ungroup if available. MV3 exposes it as
      // chrome.tabs.ungroup in Chrome 116+.
      if (chrome.tabs.ungroup) {
        await chrome.tabs.ungroup(tabIds)
      } else {
        // Fallback: create a temp group and ungroup it.
        const tmp = await chrome.tabs.group({ tabIds })
        await chrome.tabGroups.ungroup(tmp)
      }
      return { tabIds, unassigned: true }
    }
    default:
      throw new Error(`tab_group: unknown action: ${action}`)
  }
}
