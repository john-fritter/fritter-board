import type { FeedItem } from "../forum/feeds.js";
import type { Board } from "../forum/types.js";
import { escapeHtml } from "../markup/bbcode.js";

// escapeHtml covers the five XML entities too.
const x = escapeHtml;

/** RSS 2.0 for a board's newest threads. Links are absolute, as feed readers need. */
export function rssXml(origin: string, url: (p: string) => string, board: Board, items: FeedItem[]): string {
  const abs = (p: string) => `${origin}${url(p)}`;
  const entries = items
    .map(
      (i) => `    <item>
      <title>${x(i.title)}</title>
      <link>${x(abs(`/t/${i.threadId}`))}</link>
      <guid isPermaLink="true">${x(abs(`/t/${i.threadId}`))}</guid>
      <dc:creator>${x(i.authorName)}</dc:creator>
      <pubDate>${i.createdAt.toUTCString()}</pubDate>
      <description>${x(i.bodyHtml ?? "[removed by moderator]")}</description>
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${x(board.name)}</title>
    <link>${x(abs(`/b/${board.slug}`))}</link>
    <description>${x(board.description)}</description>
${entries}
  </channel>
</rss>
`;
}
