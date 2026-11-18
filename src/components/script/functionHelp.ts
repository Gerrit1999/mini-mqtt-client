export function getFunctionHelpEntries(signature: string) {
  const entries = []
  let firstObjectPrefix = ''

  for (const part of signature.split(' / ')) {
    const match = /^(await )?((?:[\w$]+\.)*)([\w$]+\(.*\))$/.exec(part)
    if (!match) return [{ text: signature, copyable: false }]

    const [, awaitPrefix = '', objectPrefix = '', call] = match
    if (entries.length === 0) firstObjectPrefix = objectPrefix
    entries.push({
      text: awaitPrefix + (objectPrefix || firstObjectPrefix) + call,
      copyable: true,
    })
  }

  return entries
}
