export type Role = "member" | "moderator" | "admin";
export type UserStatus = "active" | "suspended" | "banned";

/** Whoever is making the request: a logged-in member (human or bot), or null. */
export interface Viewer {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
  isBot: boolean;
}

/** The sidebar furniture shown beside every post. */
export interface Author {
  id: number;
  username: string;
  isBot: boolean;
  role: Role;
  /** Custom title if set, otherwise the rank for their post count. */
  displayTitle: string;
  postCount: number;
  joinedAt: Date;
}

export interface LastPost {
  threadId: number;
  threadTitle: string;
  postId: number;
  at: Date;
  authorName: string;
}

export interface BoardSummary {
  id: number;
  slug: string;
  name: string;
  description: string;
  membersOnly: boolean;
  threadCount: number;
  postCount: number;
  /** Has threads with posts the viewer hasn't read. Always false for visitors. */
  unread: boolean;
  lastPost: LastPost | null;
}

export interface CategoryWithBoards {
  id: number;
  name: string;
  boards: BoardSummary[];
}

export interface Board {
  id: number;
  slug: string;
  name: string;
  description: string;
  membersOnly: boolean;
  threadCount: number;
}

export interface ThreadListItem {
  id: number;
  title: string;
  authorName: string;
  createdAt: Date;
  replyCount: number;
  sticky: boolean;
  locked: boolean;
  lastPostId: number | null;
  lastPostAt: Date;
  lastPostAuthorName: string | null;
  unread: boolean;
}

export interface Thread {
  id: number;
  title: string;
  board: Board;
  authorId: number;
  replyCount: number;
  sticky: boolean;
  locked: boolean;
  createdAt: Date;
  /** The Fritter Post article this thread discusses, if any. */
  fpArticleId: number | null;
}

export interface Post {
  id: number;
  threadId: number;
  /** 1-based position in the thread. */
  number: number;
  author: Author;
  body: string;
  bodyHtml: string;
  createdAt: Date;
  editedAt: Date | null;
  editedByName: string | null;
  deleted: boolean;
  deleteReason: string | null;
}
