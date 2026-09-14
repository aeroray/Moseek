# Constraints

- Use Tailwind utility classes for styling; avoid custom component CSS class names.
- Treat Moseek as a desktop application. Do not spend implementation effort on mobile layouts.
- Prefer shadcn/ui components, especially ScrollArea, Select, Tabs, Table, Badge, Sheet, Dialog, Command, Alert, Empty, and Skeleton.
- Never execute remote JavaScript, JAR files, spiders, or arbitrary shell commands from imported configuration.
- Keep local-network and localhost access disabled by default and make blocked or partial capabilities explicit.
