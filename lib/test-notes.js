export const RELEASE_NOTES_FORMAT_MARKER = '<!-- merge4appstore:release-notes:v2 -->';

// Extract only explicitly marked tester instructions, including nested headings.
export function extractTestNotes(body = '') {
  const sections = [];
  let lines = [];
  let sectionLevel = null;
  let fence = null;
  const finishSection = () => {
    // Trim empty boundary lines without changing Markdown code indentation.
    const first = lines.findIndex(line => line.trim());
    const last = lines.findLastIndex(line => line.trim());
    if (first !== -1) sections.push(lines.slice(first, last + 1).join('\n'));
    lines = [];
    sectionLevel = null;
  };

  for (const line of (body || '').split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0]
        && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      if (sectionLevel !== null) lines.push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      if (sectionLevel !== null) lines.push(line);
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/);
    if (heading) {
      const level = heading[1].length;
      const title = (heading[2] || '').replace(/[\t ]+#+[\t ]*$/, '').trim();
      if (sectionLevel !== null && level <= sectionLevel) finishSection();
      if (sectionLevel === null && /^test notes$/i.test(title)) {
        sectionLevel = level;
        continue;
      }
    }
    if (sectionLevel !== null) lines.push(line);
  }
  finishSection();
  return sections.join('\n\n');
}
