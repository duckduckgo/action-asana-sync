// Setup markdown with limited tag support because Asana limits us
import markdownit from 'markdown-it'
const md = markdownit('zero', {linkify: true}).enable([
  'table',
  'heading',
  'fence',
  'block',
  'backticks',
  'code',
  'linkify',
  'link',
  'list',
  'emphasis',
  'strikethrough'
])

// Asana doesn't let us use <p></p> so instead let's just add a newline at the end
md.renderer.rules.paragraph_open = function () {
  return ''
}
md.renderer.rules.paragraph_close = function () {
  return '\n\n'
}

// Table support fixes for Asana
md.renderer.rules.thead_open = function () {
  return ''
}
md.renderer.rules.thead_close = function () {
  return ''
}
md.renderer.rules.th_open = function () {
  return '<td><strong>'
}
md.renderer.rules.th_close = function () {
  return '</strong></td>'
}
md.renderer.rules.tbody_open = function () {
  return ''
}
md.renderer.rules.tbody_close = function () {
  return ''
}

export function renderMD(text: string): string {
  // Not aware of a way to fix these with renderer rules so we tweak manually
  return md
    .render(text)
    .replace(/<pre>/gm, '')
    .replace(/<\/pre>/gm, '')
    .replace(/(<li>.*)\n/gm, '$1')
}
