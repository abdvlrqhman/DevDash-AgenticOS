import {
  AppWindow, ArrowRightLeft, Binary, Braces, CalendarClock, CaseSensitive, Clock, Code, Combine, Diff, FileArchive,
  FileImage, FileJson, FileOutput, FileText, Fingerprint, Globe, Hash, Image, Images, KeyRound, LayoutGrid, Link,
  ListOrdered, Palette, QrCode, Regex, Replace, RotateCw, Scaling, Scissors, Server, Shield, Shrink,
  SplitSquareHorizontal, Stamp, Type, Unlock,
} from 'lucide-react'
import { lazy, type ComponentType } from 'react'
import { Base64Tool, CaseTool, ColorTool, HtmlEntityTool, JsonFormatter, JsonYaml, NumberBaseTool, TimestampTool, UrlTool } from './tools-convert'
import { HashTool, LoremTool, PasswordTool, QrTool, UuidTool } from './tools-generate'
import { JwtDecoder, LineTools, RegexTester, Slugify, TextDiff } from './tools-text'
import { CronTool, HttpStatusTool, JsonQueryTool } from './tools-web'

// The image and PDF tools pull in heavy codecs (pdf-lib, pdf.js). Load them only when one of those tools is opened,
// so the hub and the lightweight text tools stay fast. ToolPage renders these inside a Suspense boundary.
const lazyTool = (load: () => Promise<{ default: ComponentType }>) => lazy(load) as unknown as ComponentType
const ImageConverter = lazyTool(() => import('./tools-image').then((m) => ({ default: m.ImageConverter })))
const ImageCompressor = lazyTool(() => import('./tools-image').then((m) => ({ default: m.ImageCompressor })))
const ImageResizer = lazyTool(() => import('./tools-image').then((m) => ({ default: m.ImageResizer })))
const FaviconMaker = lazyTool(() => import('./tools-image').then((m) => ({ default: m.FaviconMaker })))
const MergePdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.MergePdf })))
const SplitPdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.SplitPdf })))
const ExtractPages = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.ExtractPages })))
const OrganizePdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.OrganizePdf })))
const RotatePdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.RotatePdf })))
const JpgToPdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.JpgToPdf })))
const PdfToJpg = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.PdfToJpg })))
const PageNumbers = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.PageNumbers })))
const WatermarkPdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.WatermarkPdf })))
const CompressPdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.CompressPdf })))
const UnlockPdf = lazyTool(() => import('./tools-pdf').then((m) => ({ default: m.UnlockPdf })))

export type ToolCategory = 'Convert' | 'Generate' | 'Text' | 'Web' | 'Image' | 'PDF'

export type Tool = {
  id: string
  name: string
  description: string
  keywords: string[]
  category: ToolCategory
  icon: typeof Braces
  Component: ComponentType
}

export const CATEGORIES: ToolCategory[] = ['Convert', 'Generate', 'Text', 'Web', 'Image', 'PDF']

/** What each category is for, in one plain line — shown under its heading on the hub. */
export const CATEGORY_META: Record<ToolCategory, { icon: typeof Braces; description: string }> = {
  Convert: { icon: ArrowRightLeft, description: 'Reshape data from one format into another.' },
  Generate: { icon: Fingerprint, description: 'Make IDs, hashes, passwords and placeholder text.' },
  Text: { icon: Type, description: 'Compare, clean up and inspect blocks of text.' },
  Web: { icon: Globe, description: 'Everyday helpers for building and debugging web services.' },
  Image: { icon: Image, description: 'Convert, resize and compress images — right on your device.' },
  PDF: { icon: FileText, description: 'Merge, split, rotate and rework PDFs — nothing is uploaded.' },
}

export const TOOLS: Tool[] = [
  // ----- Convert -----
  { id: 'json', name: 'JSON formatter', description: 'Pretty-print, minify and validate JSON with line-pointed errors.', keywords: ['beautify', 'format', 'validate', 'prettify', 'lint'], category: 'Convert', icon: Braces, Component: JsonFormatter },
  { id: 'json-yaml', name: 'JSON ⇄ YAML', description: 'Convert between JSON and YAML in either direction.', keywords: ['yaml', 'yml', 'json', 'config'], category: 'Convert', icon: FileJson, Component: JsonYaml },
  { id: 'base64', name: 'Base64', description: 'Encode or decode Base64 text, URL-safe variant, or drop a file.', keywords: ['base64', 'encode', 'decode', 'btoa', 'atob', 'file'], category: 'Convert', icon: Binary, Component: Base64Tool },
  { id: 'url', name: 'URL encode', description: 'Percent-encode or decode URL components.', keywords: ['url', 'uri', 'percent', 'encode', 'decode', 'escape'], category: 'Convert', icon: Link, Component: UrlTool },
  { id: 'html-entities', name: 'HTML entities', description: 'Escape or unescape HTML entities like &amp; and &lt;.', keywords: ['html', 'entities', 'escape', 'unescape', 'amp'], category: 'Convert', icon: Code, Component: HtmlEntityTool },
  { id: 'timestamp', name: 'Unix time', description: 'Convert between Unix timestamps and human dates, with relative time.', keywords: ['unix', 'epoch', 'timestamp', 'date', 'time', 'iso'], category: 'Convert', icon: Clock, Component: TimestampTool },
  { id: 'number-base', name: 'Number base', description: 'Convert between decimal, hex, binary and octal (big integers).', keywords: ['base', 'hex', 'binary', 'octal', 'decimal', 'radix', 'convert'], category: 'Convert', icon: Hash, Component: NumberBaseTool },
  { id: 'case', name: 'Case converter', description: 'camelCase, snake_case, kebab-case, Title Case and more.', keywords: ['case', 'camel', 'snake', 'kebab', 'pascal', 'title', 'upper', 'lower'], category: 'Convert', icon: CaseSensitive, Component: CaseTool },
  { id: 'color', name: 'Colour converter', description: 'Convert hex, rgb and hsl with a live preview and picker.', keywords: ['color', 'colour', 'hex', 'rgb', 'hsl', 'picker'], category: 'Convert', icon: Palette, Component: ColorTool },

  // ----- Generate -----
  { id: 'uuid', name: 'UUID v4', description: 'Generate random UUIDs, one or in bulk.', keywords: ['uuid', 'guid', 'id', 'random', 'v4'], category: 'Generate', icon: Fingerprint, Component: UuidTool },
  { id: 'hash', name: 'Hash', description: 'MD5, SHA-1, SHA-256 and SHA-512 digests of text.', keywords: ['hash', 'md5', 'sha', 'sha256', 'sha512', 'digest', 'checksum'], category: 'Generate', icon: Shield, Component: HashTool },
  { id: 'password', name: 'Password', description: 'Strong random passwords with length and charset controls.', keywords: ['password', 'random', 'secret', 'generate', 'string', 'token'], category: 'Generate', icon: KeyRound, Component: PasswordTool },
  { id: 'lorem', name: 'Lorem ipsum', description: 'Placeholder words, sentences or paragraphs.', keywords: ['lorem', 'ipsum', 'placeholder', 'dummy', 'text'], category: 'Generate', icon: Type, Component: LoremTool },
  { id: 'qr', name: 'QR code', description: 'Turn any text or URL into a downloadable QR code.', keywords: ['qr', 'qrcode', 'barcode', 'url', 'png'], category: 'Generate', icon: QrCode, Component: QrTool },

  // ----- Text -----
  { id: 'diff', name: 'Text diff', description: 'Compare two blocks of text with added/removed lines highlighted.', keywords: ['diff', 'compare', 'difference', 'merge', 'change'], category: 'Text', icon: Diff, Component: TextDiff },
  { id: 'regex', name: 'Regex tester', description: 'Test a regular expression with live matches and capture groups.', keywords: ['regex', 'regexp', 'pattern', 'match', 'test'], category: 'Text', icon: Regex, Component: RegexTester },
  { id: 'jwt', name: 'JWT decoder', description: 'Decode a JWT header and payload and check expiry (no verify).', keywords: ['jwt', 'token', 'jws', 'decode', 'claims', 'auth'], category: 'Text', icon: Shield, Component: JwtDecoder },
  { id: 'lines', name: 'Sort & dedup lines', description: 'Sort, deduplicate, trim and count lines of text.', keywords: ['sort', 'dedup', 'unique', 'lines', 'trim', 'count'], category: 'Text', icon: ListOrdered, Component: LineTools },
  { id: 'slugify', name: 'Slugify', description: 'Turn any text into a clean URL slug.', keywords: ['slug', 'slugify', 'url', 'permalink', 'kebab'], category: 'Text', icon: Scissors, Component: Slugify },

  // ----- Web -----
  { id: 'cron', name: 'Cron explainer', description: 'Explain a cron expression in plain English and preview next runs.', keywords: ['cron', 'crontab', 'schedule', 'job', 'expression'], category: 'Web', icon: CalendarClock, Component: CronTool },
  { id: 'http-status', name: 'HTTP status codes', description: 'Look up any HTTP status code and what it means.', keywords: ['http', 'status', 'code', '404', '500', 'response'], category: 'Web', icon: Server, Component: HttpStatusTool },
  { id: 'json-query', name: 'JSON ⇄ query string', description: 'Convert between a URL query string and a JSON object.', keywords: ['query', 'querystring', 'json', 'url', 'params', 'search'], category: 'Web', icon: Globe, Component: JsonQueryTool },

  // ----- Image -----
  { id: 'image-convert', name: 'Image converter', description: 'Convert images between PNG, JPEG and WebP, with resize and quality.', keywords: ['image', 'convert', 'png', 'jpeg', 'jpg', 'webp', 'resize', 'batch'], category: 'Image', icon: Replace, Component: ImageConverter },
  { id: 'image-compress', name: 'Image compressor', description: 'Shrink images by re-encoding at a chosen quality, with % saved.', keywords: ['image', 'compress', 'optimise', 'optimize', 'shrink', 'smaller', 'quality'], category: 'Image', icon: Shrink, Component: ImageCompressor },
  { id: 'image-resize', name: 'Image resizer', description: 'Resize images by pixels or percent, with common presets.', keywords: ['image', 'resize', 'scale', 'dimensions', 'width', 'height', 'crop'], category: 'Image', icon: Scaling, Component: ImageResizer },
  { id: 'favicon', name: 'Favicon maker', description: 'Turn one square image into favicon and app-icon PNG sizes.', keywords: ['favicon', 'icon', 'app icon', 'apple touch', 'sizes', 'png'], category: 'Image', icon: AppWindow, Component: FaviconMaker },

  // ----- PDF -----
  { id: 'pdf-merge', name: 'Merge PDF', description: 'Combine several PDFs into one, reorderable before you save.', keywords: ['pdf', 'merge', 'combine', 'join', 'concat'], category: 'PDF', icon: Combine, Component: MergePdf },
  { id: 'pdf-split', name: 'Split PDF', description: 'Split a PDF by page ranges or every N pages into separate files.', keywords: ['pdf', 'split', 'divide', 'ranges', 'pages', 'separate'], category: 'PDF', icon: SplitSquareHorizontal, Component: SplitPdf },
  { id: 'pdf-extract', name: 'Extract pages', description: 'Pick pages from a PDF and save them as a new document.', keywords: ['pdf', 'extract', 'pages', 'pick', 'select', 'subset'], category: 'PDF', icon: FileOutput, Component: ExtractPages },
  { id: 'pdf-organize', name: 'Organize pages', description: 'Reorder and delete PDF pages with drag-and-drop thumbnails.', keywords: ['pdf', 'organize', 'organise', 'reorder', 'delete', 'rearrange', 'pages'], category: 'PDF', icon: LayoutGrid, Component: OrganizePdf },
  { id: 'pdf-rotate', name: 'Rotate PDF', description: 'Rotate every page or individual pages in 90° steps.', keywords: ['pdf', 'rotate', 'turn', 'orientation', 'landscape', 'portrait'], category: 'PDF', icon: RotateCw, Component: RotatePdf },
  { id: 'jpg-to-pdf', name: 'JPG → PDF', description: 'Combine images into a single PDF, with page size and orientation.', keywords: ['pdf', 'jpg', 'jpeg', 'png', 'image', 'images', 'to pdf', 'convert'], category: 'PDF', icon: FileImage, Component: JpgToPdf },
  { id: 'pdf-to-jpg', name: 'PDF → JPG', description: 'Render each PDF page to a JPG or PNG at a chosen resolution.', keywords: ['pdf', 'jpg', 'jpeg', 'png', 'image', 'render', 'export', 'to image'], category: 'PDF', icon: Images, Component: PdfToJpg },
  { id: 'pdf-page-numbers', name: 'Page numbers', description: 'Stamp page numbers onto a PDF with position and style options.', keywords: ['pdf', 'page numbers', 'number', 'pagination', 'stamp', 'footer'], category: 'PDF', icon: Hash, Component: PageNumbers },
  { id: 'pdf-watermark', name: 'Watermark PDF', description: 'Stamp text diagonally across every page, with opacity and angle.', keywords: ['pdf', 'watermark', 'stamp', 'overlay', 'confidential', 'draft'], category: 'PDF', icon: Stamp, Component: WatermarkPdf },
  { id: 'pdf-compress', name: 'Compress PDF', description: 'Shrink an image-heavy PDF by re-rendering pages (lossy).', keywords: ['pdf', 'compress', 'smaller', 'reduce', 'optimise', 'optimize', 'size'], category: 'PDF', icon: FileArchive, Component: CompressPdf },
  { id: 'pdf-unlock', name: 'Unlock PDF', description: 'Remove a password you know from a protected PDF.', keywords: ['pdf', 'unlock', 'password', 'decrypt', 'remove', 'protected'], category: 'PDF', icon: Unlock, Component: UnlockPdf },
]

export const TOOLS_BY_ID: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.id, t]))
