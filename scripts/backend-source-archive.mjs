// Exclude only checkout-local build metadata, never same-named dependency source.
export function backendSourceArchiveArgs(archive, work) {
  return ['--anchored', '--exclude=source/.git', '--exclude=source/target', '-cJf', archive, '-C', work, 'source', 'recipe'];
}

// Vendoring must not discard the target flags used to build the shipped bytes.
export function backendOfflineCargoConfig(original, vendored) {
  return original.trimEnd() + '\n\n' + vendored;
}
