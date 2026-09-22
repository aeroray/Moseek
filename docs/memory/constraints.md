# Constraints

- Use Tailwind utility classes for styling; avoid custom component CSS class names.
- Treat Moseek as a desktop application. Do not spend implementation effort on mobile layouts.
- Prefer shadcn/ui components, especially ScrollArea, Select, Tabs, Table, Badge, Sheet, Dialog, Command, Alert, Empty, and Skeleton.
- Never execute remote JavaScript, JAR files, spiders, or arbitrary shell commands from imported configuration.
- Keep local-network and localhost access disabled by default and make blocked or partial capabilities explicit.
- **Never rewrite source files with PowerShell's `Set-Content` / `Out-File` / `-replace | Set-Content`.** They write a UTF-8 BOM and double-encode every CJK character, and the mangling is unrecoverable once bytes are lost to replacement characters — this has now destroyed work twice. Use the `edit`/`write` tools, or `node`'s `fs.writeFileSync(path, text, "utf8")`, and check `readFileSync(path)[0] !== 0xEF` afterwards. When a file is already damaged, recover with `git show HEAD:<path>` written via node — **not** `git checkout -- <path>`, which discards uncommitted work and has also destroyed work twice.
