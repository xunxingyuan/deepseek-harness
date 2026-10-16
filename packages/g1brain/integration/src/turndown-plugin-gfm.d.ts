/** Types for the upstream GFM converter, which does not publish declarations. */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  /** GitHub-flavored tables, strikethrough, and code blocks. */
  export const gfm: TurndownService.Plugin
}
