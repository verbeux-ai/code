// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .verboo/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.verboo/**'

// Permission pattern for granting session-level access to the global ~/.verboo/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.verboo/**'

// Legacy alias kept so existing session-level rules still work during migration.
export const LEGACY_GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
