import type { ConfigDuplicateMatch } from "@/lib/tauri";

/**
 * Explains why an import looks like a configuration the user already has.
 *
 * The counts carry the decision: they tell the user whether the stored document is a trimmed
 * copy of the incoming one or the other way around, which is what decides whether skipping
 * the import would lose anything.
 */
export function describeDuplicateMatch(match: ConfigDuplicateMatch) {
  if (match.kind === "identical") {
    return `这份配置与「${match.documentName}」的内容完全相同。`;
  }
  if (match.kind === "same-origin") {
    return `这份配置与「${match.documentName}」来自同一个导入地址，内容可能已被上游更新。`;
  }
  if (match.documentSourceCount < match.candidateSourceCount) {
    return `已有配置「${match.documentName}」的 ${match.documentSourceCount} 个源全部包含在这份配置里（这份共 ${match.candidateSourceCount} 个），它看起来是这份配置被裁剪后的版本。`;
  }
  if (match.documentSourceCount > match.candidateSourceCount) {
    return `这份配置的 ${match.candidateSourceCount} 个源都已存在于「${match.documentName}」中（该配置共 ${match.documentSourceCount} 个），它看起来是「${match.documentName}」被裁剪后的版本。`;
  }
  return `这份配置与「${match.documentName}」的源完全相同（各 ${match.candidateSourceCount} 个），但内容有差异，可能是修改过参数。`;
}
