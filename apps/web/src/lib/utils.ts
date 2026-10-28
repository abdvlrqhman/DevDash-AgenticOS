export { cn } from "cn"

/** "1.5 MB": a file's size the way people read it. */
export const bytes = (n: number | null) => n === null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`
