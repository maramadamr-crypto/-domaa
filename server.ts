import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT =
  process.env.NODE_ENV === 'production'
    ? Number(process.env.PORT) || 3000
    : 3000;

// Body parser with 100MB limit to allow large books and image dataURLs without payload limits
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist')));

// Lazy-initialize GoogleGenAI SDK
let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import { getOrCreateUser, getCloudDocuments, saveCloudDocument, deleteCloudDocument } from './src/db/users.ts';

// PostgreSQL + Firebase Database Sync endpoints
// 1. Sync User to Cloud SQL PostgreSQL
app.post('/api/sync-user', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const user = req.user!;
    const { displayName, photoURL } = req.body || {};
    const syncedUser = await getOrCreateUser(
      user.uid,
      user.email || '',
      displayName || user.name || 'طالب متميز',
      photoURL || user.picture || ''
    );
    return res.json({ success: true, user: syncedUser });
  } catch (error: any) {
    console.error('User sync error in PostgreSQL:', error);
    return res.status(500).json({ error: 'Failed to sync user to database', details: error?.message });
  }
});

// 2. Fetch Documents from PostgreSQL
app.get('/api/documents', async (_req, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, documents: [] });
    }
    const docs = await getCloudDocuments();
    return res.json({ success: true, documents: docs });
  } catch (error: any) {
    console.error('Fetch documents error:', error);
    return res.status(500).json({ error: 'Failed to fetch documents', details: error?.message });
  }
});

// 3. Save Document to PostgreSQL (authenticated)
app.post('/api/documents', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const user = req.user!;
    const docData = req.body;
    if (!docData || typeof docData.id !== 'string' || !docData.id.trim() || typeof docData.title !== 'string' || !docData.title.trim()) {
      return res.status(400).json({ error: 'Invalid document payload' });
    }
    const saved = await saveCloudDocument({
      ...docData,
      userId: user.uid,
    });
    return res.json({ success: true, document: saved });
  } catch (error: any) {
    console.error('Save document error in PostgreSQL:', error);
    return res.status(500).json({ error: 'Failed to save document', details: error?.message });
  }
});

// 4. Delete Document from PostgreSQL (authenticated)
app.delete('/api/documents/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Document id is required' });
    }
    await deleteCloudDocument(id, req.user!.uid);
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Delete document error in PostgreSQL:', error);
    return res.status(500).json({ error: 'Failed to delete document', details: error?.message });
  }
});

// 5. Videos Endpoints
app.get('/api/videos', async (_req, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, videos: [] });
    }
    const { db } = await import('./src/db/index.ts');
    const { videos } = await import('./src/db/schema.ts');
    const { desc } = await import('drizzle-orm');
    const rows = await db.select().from(videos).orderBy(desc(videos.createdAt));
    return res.json({ success: true, videos: rows });
  } catch (err: any) {
    console.warn('PostgreSQL videos fetch note:', err?.message);
    return res.json({ success: true, videos: [] });
  }
});

app.post('/api/videos', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id, title, description, type, durationSeconds, videoUrl, thumbnailUrl, subject, grade, author, likesCount } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Video id is required' });
    }
    const { db } = await import('./src/db/index.ts');
    const { videos } = await import('./src/db/schema.ts');
    const safeDuration = Math.max(1, Math.round(Number(durationSeconds) || 60));
    const safeLikes = Math.max(0, Math.round(Number(likesCount) || 0));
    const safeType = type === 'lesson' ? 'lesson' : 'shorts';
    await db.insert(videos).values({
      id,
      userId: req.user!.uid,
      author: author || 'ناشر',
      title: title || 'فيديو تعليمي',
      description: description || '',
      type: safeType,
      durationSeconds: safeDuration,
      videoUrl: videoUrl || '',
      thumbnailUrl: thumbnailUrl || '',
      subject: subject || 'arabic',
      grade: grade || 'الصف الخامس الابتدائي',
      likesCount: safeLikes,
    }).onConflictDoUpdate({
      target: videos.id,
      set: {
        title: title || 'فيديو تعليمي',
        description: description || '',
        type: safeType,
        durationSeconds: safeDuration,
        videoUrl: videoUrl || '',
        thumbnailUrl: thumbnailUrl || '',
        subject: subject || 'arabic',
        grade: grade || 'الصف الخامس الابتدائي',
        likesCount: safeLikes,
        updatedAt: new Date(),
      },
    });
    return res.json({ success: true });
  } catch (err: any) {
    console.warn('PostgreSQL video save error note:', err?.message);
    return res.status(500).json({ error: 'Failed to save video to database' });
  }
});

app.delete('/api/videos/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Video id is required' });
    }
    const { db } = await import('./src/db/index.ts');
    const { videos } = await import('./src/db/schema.ts');
    const { and, eq } = await import('drizzle-orm');
    await db.delete(videos).where(and(eq(videos.id, id), eq(videos.userId, req.user!.uid)));
    return res.json({ success: true });
  } catch (err: any) {
    console.warn('PostgreSQL video delete error note:', err?.message);
    return res.status(500).json({ error: 'Failed to delete video from database' });
  }
});

// 6. Quizzes Endpoints
app.post('/api/quizzes', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id, author, title, grade, durationMode, expireDate, totalQuestions, questionsJson, subject, attemptsCount } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Quiz id is required' });
    }
    const { db } = await import('./src/db/index.ts');
    const { quizzes } = await import('./src/db/schema.ts');
    const safeTotal = Math.max(1, Math.round(Number(totalQuestions) || 5));
    const safeAttempts = Math.max(0, Math.round(Number(attemptsCount) || 0));
    await db.insert(quizzes).values({
      id,
      userId: req.user!.uid,
      author: author || 'معلم',
      title: title || 'اختبار تفاعلي',
      grade: grade || 'الصف الخامس الابتدائي',
      durationMode: durationMode || 'always',
      expireDate: expireDate || null,
      totalQuestions: safeTotal,
      questionsJson: questionsJson || '[]',
      subject: subject || 'arabic',
      attemptsCount: safeAttempts,
    }).onConflictDoUpdate({
      target: quizzes.id,
      set: {
        title: title || 'اختبار تفاعلي',
        grade: grade || 'الصف الخامس الابتدائي',
        totalQuestions: safeTotal,
        questionsJson: questionsJson || '[]',
        subject: subject || 'arabic',
        attemptsCount: safeAttempts,
      },
    });
    return res.json({ success: true });
  } catch (err: any) {
    console.warn('PostgreSQL quiz save error note:', err?.message);
    return res.status(500).json({ error: 'Failed to save quiz to database' });
  }
});

app.delete('/api/quizzes/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Quiz id is required' });
    }
    const { db } = await import('./src/db/index.ts');
    const { quizzes } = await import('./src/db/schema.ts');
    const { and, eq } = await import('drizzle-orm');
    await db.delete(quizzes).where(and(eq(quizzes.id, id), eq(quizzes.userId, req.user!.uid)));
    return res.json({ success: true });
  } catch (err: any) {
    console.warn('PostgreSQL quiz delete error note:', err?.message);
    return res.status(500).json({ error: 'Failed to delete quiz from database' });
  }
});

// 7. Comments Endpoints (PostgreSQL / Cloud SQL)
app.post('/api/comments', async (req, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id, targetId, targetType, userId, authorName, authorPhoto, authorRole, content, reaction, likesCount } = req.body || {};
    if (!id || !targetId) {
      return res.status(400).json({ error: 'Comment id and targetId are required' });
    }
    const { db } = await import('./src/db/index.ts');
    const { comments } = await import('./src/db/schema.ts');
    const safeLikes = Math.max(0, Math.round(Number(likesCount) || 0));
    await db.insert(comments).values({
      id,
      targetId,
      targetType: targetType || 'video',
      userId: userId || 'anonymous',
      authorName: authorName || 'مستخدم',
      authorPhoto: authorPhoto || null,
      authorRole: authorRole || 'student',
      content: content || '',
      reaction: reaction || null,
      likesCount: safeLikes,
    }).onConflictDoUpdate({
      target: comments.id,
      set: {
        content: content || '',
        reaction: reaction || null,
        likesCount: safeLikes,
      },
    });
    return res.json({ success: true });
  } catch (err: any) {
    console.warn('PostgreSQL comment save error note:', err?.message);
    return res.status(500).json({ error: 'Failed to save comment to database' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    if (!process.env.SQL_HOST) {
      return res.json({ success: true, skipped: true });
    }
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Comment id is required' });
    }
    const { db } = await import('./src/db/index.ts');
    const { comments } = await import('./src/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    await db.delete(comments).where(eq(comments.id, id));
    return res.json({ success: true });
  } catch (err: any) {
    console.warn('PostgreSQL comment delete error note:', err?.message);
    return res.status(500).json({ error: 'Failed to delete comment from database' });
  }
});

// 8. Public Cross-Device Document, Videos, Quizzes, Comments, Reminders & Deletion Tombstones Relay (Zero login required)
const PUBLIC_DATA_ROOT = path.join(__dirname, '.qalami-data');
const PUBLIC_DOCS_DIR = path.join(PUBLIC_DATA_ROOT, 'documents');
const PUBLIC_STATE_FILE = path.join(PUBLIC_DATA_ROOT, 'state.json');
const publicDocSseClients = new Set<express.Response>();

interface PublicRelayState {
  deletedDocuments: Record<string, number>;
  videos: Record<string, any>;
  deletedVideos: Record<string, number>;
  quizzes: Record<string, any>;
  deletedQuizzes: Record<string, number>;
  comments: Record<string, any>;
  deletedComments: Record<string, number>;
  deletedReminders: Record<string, number>;
}

let cachedPublicState: PublicRelayState | null = null;
let stateWritePromise: Promise<void> = Promise.resolve();

function createEmptyPublicState(): PublicRelayState {
  return {
    deletedDocuments: {},
    videos: {},
    deletedVideos: {},
    quizzes: {},
    deletedQuizzes: {},
    comments: {},
    deletedComments: {},
    deletedReminders: {},
  };
}

async function loadPublicState(): Promise<PublicRelayState> {
  if (cachedPublicState) return cachedPublicState;
  await fs.mkdir(PUBLIC_DATA_ROOT, { recursive: true });
  try {
    const raw = await fs.readFile(PUBLIC_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const empty = createEmptyPublicState();
    cachedPublicState = {
      deletedDocuments: parsed?.deletedDocuments && typeof parsed.deletedDocuments === 'object' ? parsed.deletedDocuments : empty.deletedDocuments,
      videos: parsed?.videos && typeof parsed.videos === 'object' ? parsed.videos : empty.videos,
      deletedVideos: parsed?.deletedVideos && typeof parsed.deletedVideos === 'object' ? parsed.deletedVideos : empty.deletedVideos,
      quizzes: parsed?.quizzes && typeof parsed.quizzes === 'object' ? parsed.quizzes : empty.quizzes,
      deletedQuizzes: parsed?.deletedQuizzes && typeof parsed.deletedQuizzes === 'object' ? parsed.deletedQuizzes : empty.deletedQuizzes,
      comments: parsed?.comments && typeof parsed.comments === 'object' ? parsed.comments : empty.comments,
      deletedComments: parsed?.deletedComments && typeof parsed.deletedComments === 'object' ? parsed.deletedComments : empty.deletedComments,
      deletedReminders: parsed?.deletedReminders && typeof parsed.deletedReminders === 'object' ? parsed.deletedReminders : empty.deletedReminders,
    };
  } catch {
    cachedPublicState = createEmptyPublicState();
  }
  return cachedPublicState;
}

async function persistPublicState(): Promise<void> {
  const snapshot = cachedPublicState;
  if (!snapshot) return;
  const serialized = JSON.stringify(snapshot);
  stateWritePromise = stateWritePromise
    .then(async () => {
      await fs.mkdir(PUBLIC_DATA_ROOT, { recursive: true });
      await fs.writeFile(PUBLIC_STATE_FILE, serialized, 'utf-8');
    })
    .catch((err) => {
      console.warn('Public state persist note:', err?.message);
    });
  return stateWritePromise;
}

function broadcastPublicDocEvent(payload: Record<string, any>) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of publicDocSseClients) {
    try {
      client.write(frame);
    } catch {
      publicDocSseClients.delete(client);
    }
  }
}

function sanitizePublicDocId(rawId: unknown): string {
  if (typeof rawId !== 'string') return '';
  const cleaned = rawId.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

function isDocDeletedInState(state: PublicRelayState, rawId?: string, safeId?: string): boolean {
  if (rawId && state.deletedDocuments[rawId]) return true;
  if (safeId && state.deletedDocuments[safeId]) return true;
  return false;
}

async function ensurePublicDocDir(docId?: string): Promise<string> {
  await fs.mkdir(PUBLIC_DOCS_DIR, { recursive: true });
  if (!docId) return PUBLIC_DOCS_DIR;
  const safeId = sanitizePublicDocId(docId);
  if (!safeId) throw new Error('Invalid document id');
  const dir = path.join(PUBLIC_DOCS_DIR, safeId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Instant real-time Server-Sent Events stream for cross-device sync (documents, videos, quizzes, comments, reminders, deletions)
app.get('/api/public-documents/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
  publicDocSseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      publicDocSseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    publicDocSseClients.delete(res);
  });
});

// List all shared documents + persistent deletedDocIds tombstones
app.get('/api/public-documents', async (_req, res) => {
  try {
    await ensurePublicDocDir();
    const state = await loadPublicState();
    const entries = await fs.readdir(PUBLIC_DOCS_DIR, { withFileTypes: true });
    const docs: any[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isDocDeletedInState(state, entry.name, entry.name)) {
        fs.rm(path.join(PUBLIC_DOCS_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const metaPath = path.join(PUBLIC_DOCS_DIR, entry.name, 'meta.json');
      try {
        const raw = await fs.readFile(metaPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) {
          if (isDocDeletedInState(state, parsed.id, entry.name)) {
            fs.rm(path.join(PUBLIC_DOCS_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
            continue;
          }
          docs.push(parsed);
        }
      } catch {
        // skip incomplete/missing meta
      }
    }
    docs.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt || 0).getTime() -
        new Date(a.updatedAt || a.createdAt || 0).getTime()
    );
    return res.json({
      success: true,
      documents: docs,
      deletedDocIds: Object.keys(state.deletedDocuments),
    });
  } catch (err: any) {
    console.warn('Public documents list note:', err?.message);
    return res.json({ success: true, documents: [], deletedDocIds: [] });
  }
});

// Save or update document metadata (guarded against deleted tombstones so stale offline devices cannot resurrect)
app.post('/api/public-documents', async (req, res) => {
  try {
    const body = req.body || {};
    const rawId = typeof body.id === 'string' ? body.id.trim() : '';
    const safeId = sanitizePublicDocId(rawId);
    if (!safeId || typeof body.title !== 'string' || !body.title.trim()) {
      return res.status(400).json({ error: 'Invalid public document payload' });
    }

    const state = await loadPublicState();
    if (isDocDeletedInState(state, rawId, safeId)) {
      return res.json({ success: true, deleted: true, document: null });
    }

    const dir = await ensurePublicDocDir(safeId);
    const metaPath = path.join(dir, 'meta.json');

    let existing: any = null;
    try {
      const prevRaw = await fs.readFile(metaPath, 'utf-8');
      existing = JSON.parse(prevRaw);
    } catch {
      existing = null;
    }

    const nowIso = new Date().toISOString();
    const mergedMeta = {
      id: rawId,
      title: String(body.title).trim().slice(0, 200),
      subject: String(body.subject || existing?.subject || 'arabic').slice(0, 50),
      customSubjectName: String(body.customSubjectName ?? existing?.customSubjectName ?? '').slice(0, 100),
      docType: String(body.docType || existing?.docType || 'booklet').slice(0, 50),
      format: String(body.format || existing?.format || 'files').slice(0, 50),
      grade: String(body.grade || existing?.grade || 'الصف الخامس الابتدائي').slice(0, 100),
      term: String(body.term || existing?.term || 'term1').slice(0, 50),
      author: String(body.author || existing?.author || 'ناشر').slice(0, 100),
      description: String(body.description ?? existing?.description ?? '').slice(0, 2000),
      userId: String(body.userId || existing?.userId || 'public_publisher').slice(0, 128),
      averageRating: Number(body.averageRating ?? existing?.averageRating ?? 5),
      ratingsCount: Number(body.ratingsCount ?? existing?.ratingsCount ?? 0),
      comments: Array.isArray(body.comments) ? body.comments.slice(-20) : (existing?.comments || []),
      bookmarks: Array.isArray(body.bookmarks) ? body.bookmarks.slice(0, 500) : (existing?.bookmarks || []),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 20) : (existing?.tags || []),
      pageCount: Math.max(1, Math.min(5000, Number(body.pageCount ?? existing?.pageCount ?? 1))),
      coverImageUrl:
        typeof body.coverImageUrl === 'string' && body.coverImageUrl.length > 100
          ? body.coverImageUrl
          : existing?.coverImageUrl || '',
      annotationsJson:
        typeof body.annotationsJson === 'string' && body.annotationsJson.length > 0
          ? body.annotationsJson
          : existing?.annotationsJson || '',
      createdAt: existing?.createdAt || body.createdAt || nowIso,
      updatedAt: nowIso,
    };

    await fs.writeFile(metaPath, JSON.stringify(mergedMeta), 'utf-8');
    broadcastPublicDocEvent({ type: 'doc_updated', doc: mergedMeta });
    return res.json({ success: true, document: mergedMeta });
  } catch (err: any) {
    console.warn('Public document save note:', err?.message);
    return res.status(500).json({ error: 'Failed to save public document' });
  }
});

// Upload original pages in batches for any document (supports 1..5000 pages, guarded against tombstones)
app.post('/api/public-documents/:id/pages', async (req, res) => {
  try {
    const rawId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const safeId = sanitizePublicDocId(rawId);
    if (!safeId) {
      return res.status(400).json({ error: 'Invalid document id' });
    }

    const state = await loadPublicState();
    if (isDocDeletedInState(state, rawId, safeId)) {
      return res.json({ success: true, deleted: true, savedCount: 0 });
    }

    const pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
    if (pages.length === 0) {
      return res.json({ success: true, savedCount: 0 });
    }

    const dir = await ensurePublicDocDir(safeId);
    let savedCount = 0;
    const savedPageNumbers: number[] = [];
    let resolvedDocId = rawId;

    for (const item of pages.slice(0, 25)) {
      const pageNumber = Math.round(Number(item?.pageNumber));
      const imageUrl = typeof item?.imageUrl === 'string' ? item.imageUrl : '';
      if (!Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > 5000) continue;
      if (!imageUrl || imageUrl === 'data:,' || imageUrl.startsWith('data:image/svg+xml') || imageUrl.length < 100) {
        continue;
      }

      const pagePayload = {
        pageNumber,
        imageUrl,
        annotationsJson: typeof item?.annotationsJson === 'string' ? item.annotationsJson : '',
        updatedAt: new Date().toISOString(),
      };
      const pagePath = path.join(dir, `p_${pageNumber}.json`);
      await fs.writeFile(pagePath, JSON.stringify(pagePayload), 'utf-8');
      savedCount++;
      savedPageNumbers.push(pageNumber);

      // Backfill coverImageUrl in meta.json from page 1 if missing
      if (pageNumber === 1) {
        try {
          const metaPath = path.join(dir, 'meta.json');
          const rawMeta = await fs.readFile(metaPath, 'utf-8');
          const parsedMeta = JSON.parse(rawMeta);
          if (parsedMeta?.id) resolvedDocId = parsedMeta.id;
          if (parsedMeta && (!parsedMeta.coverImageUrl || parsedMeta.coverImageUrl.length < 100)) {
            parsedMeta.coverImageUrl = imageUrl;
            await fs.writeFile(metaPath, JSON.stringify(parsedMeta), 'utf-8');
          }
        } catch {
          // ignore if meta not written yet
        }
      }
    }

    if (savedPageNumbers.length > 0) {
      broadcastPublicDocEvent({
        type: 'pages_updated',
        docId: resolvedDocId,
        pageNumbers: savedPageNumbers,
      });
    }

    return res.json({ success: true, savedCount });
  } catch (err: any) {
    console.warn('Public document pages upload note:', err?.message);
    return res.status(500).json({ error: 'Failed to save document pages' });
  }
});

// Get chunked range or explicit list of pages (?nums=1,2,3 or ?from=1&to=10)
app.get('/api/public-documents/:id/pages', async (req, res) => {
  try {
    const rawId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const safeId = sanitizePublicDocId(rawId);
    if (!safeId) {
      return res.json({ success: true, pages: [] });
    }
    const state = await loadPublicState();
    if (isDocDeletedInState(state, rawId, safeId)) {
      return res.json({ success: true, pages: [], deleted: true });
    }
    const dir = path.join(PUBLIC_DOCS_DIR, safeId);

    let targetNums: number[] = [];
    if (typeof req.query.nums === 'string' && req.query.nums.trim()) {
      targetNums = req.query.nums
        .split(',')
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5000)
        .slice(0, 25);
    } else {
      const from = Math.max(1, parseInt(String(req.query.from || '1'), 10) || 1);
      const to = Math.min(5000, Math.max(from, parseInt(String(req.query.to || String(from + 7)), 10) || from + 7));
      for (let p = from; p <= Math.min(to, from + 24); p++) {
        targetNums.push(p);
      }
    }

    const pages: any[] = [];
    for (const num of targetNums) {
      try {
        const raw = await fs.readFile(path.join(dir, `p_${num}.json`), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.imageUrl === 'string' && parsed.imageUrl.length >= 100) {
          pages.push(parsed);
        }
      } catch {
        // page file not uploaded yet
      }
    }

    return res.json({ success: true, pages });
  } catch (err: any) {
    console.warn('Public document pages batch fetch note:', err?.message);
    return res.json({ success: true, pages: [] });
  }
});

// Get single original page
app.get('/api/public-documents/:id/pages/:pageNumber', async (req, res) => {
  try {
    const rawId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const safeId = sanitizePublicDocId(rawId);
    const pageNumber = parseInt(req.params.pageNumber, 10);
    if (!safeId || !Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > 5000) {
      return res.json({ success: true, page: null });
    }
    const state = await loadPublicState();
    if (isDocDeletedInState(state, rawId, safeId)) {
      return res.json({ success: true, page: null, deleted: true });
    }
    const pagePath = path.join(PUBLIC_DOCS_DIR, safeId, `p_${pageNumber}.json`);
    try {
      const raw = await fs.readFile(pagePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return res.json({ success: true, page: parsed });
    } catch {
      return res.json({ success: true, page: null });
    }
  } catch (err: any) {
    console.warn('Public document single page fetch note:', err?.message);
    return res.json({ success: true, page: null });
  }
});

// Delete a shared public document and store persistent tombstone
app.delete('/api/public-documents/:id', async (req, res) => {
  try {
    const rawId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const safeId = sanitizePublicDocId(rawId);
    if (!safeId) {
      return res.json({ success: true });
    }
    const dir = path.join(PUBLIC_DOCS_DIR, safeId);
    let docId = rawId;
    try {
      const rawMeta = await fs.readFile(path.join(dir, 'meta.json'), 'utf-8');
      const parsedMeta = JSON.parse(rawMeta);
      if (parsedMeta?.id) docId = parsedMeta.id;
    } catch {
      // ignore
    }
    await fs.rm(dir, { recursive: true, force: true });

    const state = await loadPublicState();
    const now = Date.now();
    state.deletedDocuments[docId] = now;
    if (rawId) state.deletedDocuments[rawId] = now;
    state.deletedDocuments[safeId] = now;
    await persistPublicState();

    broadcastPublicDocEvent({ type: 'doc_deleted', docId });
    return res.json({ success: true, docId });
  } catch (err: any) {
    console.warn('Public document delete note:', err?.message);
    return res.json({ success: true });
  }
});

// Unified zero-login public sync state (videos, quizzes, comments, reminders + all deletion tombstones)
app.get('/api/public-sync', async (_req, res) => {
  try {
    const state = await loadPublicState();
    const videos = Object.values(state.videos)
      .filter((v: any) => v?.id && !state.deletedVideos[v.id])
      .sort(
        (a: any, b: any) =>
          new Date(b.updatedAt || b.createdAt || 0).getTime() -
          new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
    const quizzes = Object.values(state.quizzes)
      .filter((q: any) => q?.id && !state.deletedQuizzes[q.id])
      .sort(
        (a: any, b: any) =>
          new Date(b.createdAt || 0).getTime() -
          new Date(a.createdAt || 0).getTime()
      );
    const comments = Object.values(state.comments)
      .filter((c: any) => c?.id && !state.deletedComments[c.id])
      .sort(
        (a: any, b: any) =>
          new Date(b.createdAt || 0).getTime() -
          new Date(a.createdAt || 0).getTime()
      );

    return res.json({
      success: true,
      videos,
      deletedVideoIds: Object.keys(state.deletedVideos),
      quizzes,
      deletedQuizIds: Object.keys(state.deletedQuizzes),
      comments,
      deletedCommentIds: Object.keys(state.deletedComments),
      deletedReminderIds: Object.keys(state.deletedReminders),
    });
  } catch (err: any) {
    console.warn('Public sync fetch note:', err?.message);
    return res.json({
      success: true,
      videos: [],
      deletedVideoIds: [],
      quizzes: [],
      deletedQuizIds: [],
      comments: [],
      deletedCommentIds: [],
      deletedReminderIds: [],
    });
  }
});

// Public Videos (Shorts & Lessons)
app.post('/api/public-videos', async (req, res) => {
  try {
    const v = req.body || {};
    const id = typeof v.id === 'string' ? v.id.trim() : '';
    if (!id) {
      return res.status(400).json({ error: 'Video id is required' });
    }
    const state = await loadPublicState();
    if (state.deletedVideos[id]) {
      return res.json({ success: true, deleted: true });
    }

    const safeVideoUrl =
      typeof v.videoUrl === 'string' && !v.videoUrl.startsWith('blob:') ? v.videoUrl : '';
    const safeThumbUrl =
      typeof v.thumbnailUrl === 'string' && !v.thumbnailUrl.startsWith('blob:') ? v.thumbnailUrl : '';
    const existing = state.videos[id] || {};
    const nowIso = new Date().toISOString();

    const savedVideo = {
      id,
      title: String(v.title || existing.title || 'فيديو تعليمي').slice(0, 200),
      description: String(v.description ?? existing.description ?? '').slice(0, 2000),
      videoUrl: safeVideoUrl || existing.videoUrl || '',
      thumbnailUrl: safeThumbUrl || existing.thumbnailUrl || '',
      durationSeconds: Math.max(1, Math.round(Number(v.durationSeconds ?? existing.durationSeconds ?? 30))),
      type: (v.type || existing.type) === 'lesson' ? 'lesson' : 'shorts',
      subject: String(v.subject || existing.subject || 'arabic').slice(0, 50),
      grade: String(v.grade || existing.grade || 'الصف الخامس الابتدائي').slice(0, 100),
      userId: String(v.userId || existing.userId || 'public_publisher').slice(0, 128),
      author: String(v.author || existing.author || 'ناشر').slice(0, 100),
      authorPhoto: String(v.authorPhoto ?? existing.authorPhoto ?? '').slice(0, 195000),
      likesCount: Math.max(0, Math.round(Number(v.likesCount ?? existing.likesCount ?? 0))),
      sharesCount: Math.max(0, Math.round(Number(v.sharesCount ?? existing.sharesCount ?? 0))),
      commentsCount: Math.max(0, Math.round(Number(v.commentsCount ?? existing.commentsCount ?? 0))),
      comments: Array.isArray(existing.comments) ? existing.comments : [],
      createdAt: existing.createdAt || v.createdAt || nowIso,
      updatedAt: nowIso,
    };

    state.videos[id] = savedVideo;
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'video_updated', video: savedVideo });
    return res.json({ success: true, video: savedVideo });
  } catch (err: any) {
    console.warn('Public video save note:', err?.message);
    return res.status(500).json({ error: 'Failed to save public video' });
  }
});

app.delete('/api/public-videos/:id', async (req, res) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) return res.json({ success: true });
    const state = await loadPublicState();
    delete state.videos[id];
    state.deletedVideos[id] = Date.now();
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'video_deleted', videoId: id });
    return res.json({ success: true, videoId: id });
  } catch (err: any) {
    console.warn('Public video delete note:', err?.message);
    return res.json({ success: true });
  }
});

// Public Quizzes
app.post('/api/public-quizzes', async (req, res) => {
  try {
    const q = req.body || {};
    const id = typeof q.id === 'string' ? q.id.trim() : '';
    if (!id) {
      return res.status(400).json({ error: 'Quiz id is required' });
    }
    const state = await loadPublicState();
    if (state.deletedQuizzes[id]) {
      return res.json({ success: true, deleted: true });
    }

    const existing = state.quizzes[id] || {};
    const questions = Array.isArray(q.questions) ? q.questions : (existing.questions || []);
    const savedQuiz = {
      id,
      userId: String(q.userId || existing.userId || 'public_publisher').slice(0, 128),
      author: String(q.author || existing.author || 'معلم').slice(0, 100),
      title: String(q.title || existing.title || 'اختبار تفاعلي').slice(0, 200),
      grade: String(q.grade || existing.grade || 'الصف الخامس الابتدائي').slice(0, 100),
      durationMode: (q.durationMode || existing.durationMode) === 'temporary' ? 'temporary' : 'always',
      expireDate: q.expireDate || existing.expireDate || undefined,
      totalQuestions: Math.max(0, Math.round(Number(q.totalQuestions ?? questions.length ?? 0))),
      questions,
      subject: String(q.subject || existing.subject || 'arabic').slice(0, 50),
      attemptsCount: Math.max(0, Math.round(Number(q.attemptsCount ?? existing.attemptsCount ?? 0))),
      createdAt: existing.createdAt || q.createdAt || new Date().toISOString(),
    };

    state.quizzes[id] = savedQuiz;
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'quiz_updated', quiz: savedQuiz });
    return res.json({ success: true, quiz: savedQuiz });
  } catch (err: any) {
    console.warn('Public quiz save note:', err?.message);
    return res.status(500).json({ error: 'Failed to save public quiz' });
  }
});

app.delete('/api/public-quizzes/:id', async (req, res) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) return res.json({ success: true });
    const state = await loadPublicState();
    delete state.quizzes[id];
    state.deletedQuizzes[id] = Date.now();
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'quiz_deleted', quizId: id });
    return res.json({ success: true, quizId: id });
  } catch (err: any) {
    console.warn('Public quiz delete note:', err?.message);
    return res.json({ success: true });
  }
});

// Public Comments & Deletions
app.post('/api/public-comments', async (req, res) => {
  try {
    const c = req.body || {};
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    const targetId = typeof c.targetId === 'string' ? c.targetId.trim() : '';
    if (!id || !targetId) {
      return res.status(400).json({ error: 'Comment id and targetId are required' });
    }
    const state = await loadPublicState();
    if (state.deletedComments[id]) {
      return res.json({ success: true, deleted: true });
    }

    const savedComment = {
      id,
      targetId,
      targetType: c.targetType === 'document' ? 'document' : 'video',
      userId: String(c.userId || 'guest_student').slice(0, 128),
      userName: String(c.userName || 'طالب').slice(0, 100),
      userPhotoURL: typeof c.userPhotoURL === 'string' ? c.userPhotoURL.slice(0, 195000) : undefined,
      role: ['student', 'teacher', 'parent'].includes(c.role) ? c.role : 'student',
      content: String(c.content || '').slice(0, 2000),
      likesCount: Math.max(0, Math.round(Number(c.likesCount) || 0)),
      createdAt: c.createdAt || new Date().toISOString(),
    };

    state.comments[id] = savedComment;
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'comment_updated', comment: savedComment });
    return res.json({ success: true, comment: savedComment });
  } catch (err: any) {
    console.warn('Public comment save note:', err?.message);
    return res.status(500).json({ error: 'Failed to save public comment' });
  }
});

app.delete('/api/public-comments/:id', async (req, res) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) return res.json({ success: true });
    const state = await loadPublicState();
    const targetId =
      (typeof req.query.targetId === 'string' && req.query.targetId.trim()) ||
      stateTargetIdFallback(state, id);
    delete state.comments[id];
    state.deletedComments[id] = Date.now();
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'comment_deleted', commentId: id, targetId });
    return res.json({ success: true, commentId: id });
  } catch (err: any) {
    console.warn('Public comment delete note:', err?.message);
    return res.json({ success: true });
  }
});

function stateTargetIdFallback(state: PublicRelayState | null, commentId: string): string {
  return state?.comments?.[commentId]?.targetId || '';
}

// Public Reminder Deletion Tombstone
app.delete('/api/public-reminders/:id', async (req, res) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id) return res.json({ success: true });
    const state = await loadPublicState();
    state.deletedReminders[id] = Date.now();
    await persistPublicState();
    broadcastPublicDocEvent({ type: 'reminder_deleted', reminderId: id });
    return res.json({ success: true, reminderId: id });
  } catch (err: any) {
    console.warn('Public reminder delete note:', err?.message);
    return res.json({ success: true });
  }
});




// AI Tutor Chat / Study Assistant endpoint
app.post('/api/ai-tutor', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        error: 'خدمة المعلم الذكي غير مفعلة حالياً (مفتاح الذكاء الاصطناعي غير مضبوط).',
      });
    }

    const { 
      question = '', 
      docTitle, 
      subjectName, 
      pageNumber, 
      pageImage,
      chatHistory = [],
      attachments = [] 
    } = req.body || {};

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const effectiveQuestion = typeof question === 'string' && question.trim()
      ? question.trim()
      : hasAttachments
        ? 'اشرح لي المرفقات المرسلة وساعدني في فهمها وحلها خطوة بخطوة.'
        : '';

    if (!effectiveQuestion) {
      return res.status(400).json({ error: 'يرجى كتابة سؤالك أو إرفاق ملف أولاً' });
    }

    const systemInstruction = `أنت «المعلم الذكي» لطلاب الصف الخامس الابتدائي في مصر.
مهمتك:
- مساعدة الطالب في فهم دروس ومذكرات الصف الخامس (اللغة العربية، الدراسات الاجتماعية، التربية الدينية، العلوم Science، الرياضيات Math، Connect، Connect Plus، وتكنولوجيا المعلومات ICT).
- تقديم إجابات واضحة، تعليمية، ومبسطة تناسب سن وفهم طالب الصف الخامس (بطول متوسط واضح ومباشر).
- تشجيع الطالب وتقديم أمثلة واقعية.
- عند شرح أسئلة الامتحانات أو النحو أو حل المسائل، اشرح خطوة بخطوة مع التعليل.
- إذا أرسل الطالب صورة لصفحة المذكرة أو الامتحان أو أرفق ملفاً أو فيديو، اقرأه بدقة وساعده في حله وفهمه.
- التحدث باللغة العربية الفصحى البسيطة والمحببة للأطفال.`;

    // Context metadata
    let contextText = `[سياق المذاكرة الحالي]\nالمذكرة/الكتاب: ${docTitle || 'مذكرة الصف الخامس'}\nالمادة: ${subjectName || 'عام'}\nرقم الصفحة المعروضة: ${pageNumber || 1}\n\n`;

    // If chat history is provided, include brief history for conversational continuity
    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
      contextText += `[سياق المحادثة السابقة]\n`;
      chatHistory.slice(-4).forEach((msg: any) => {
        contextText += `${msg.role === 'user' ? 'الطالب' : 'المعلم'}: ${msg.text}\n`;
      });
      contextText += `\n`;
    }

    contextText += `سؤال الطالب الحالي: ${effectiveQuestion}`;

    const parts: any[] = [];

    // Multimodal page image
    if (pageImage && typeof pageImage === 'string' && pageImage.startsWith('data:image/')) {
      const match = pageImage.match(/^data:(image\/[a-zA-Z0-9.+_-]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }

    // Process additional student attachments (+ button: images, videos, documents, audio, links)
    let attachmentsContext = '';
    if (hasAttachments) {
      for (const att of attachments) {
        if (att.dataUrl && typeof att.dataUrl === 'string' && att.dataUrl.startsWith('data:image/')) {
          const match = att.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+_-]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            });
            attachmentsContext += `\n[مرفق صورة إضافية من الطالب: "${att.name || 'صورة الواجب أو السؤال'}"]`;
          }
        } else {
          attachmentsContext += `\n[مرفق إضافي من الطالب: نوع (${att.type || 'ملف'}) - اسم الملف: "${att.name || 'مرفق'}"${att.textContent ? ` - نص أو محتوى: "${String(att.textContent).slice(0, 3000)}"` : ''}${att.url ? ` - رابط: ${att.url}` : ''}]`;
        }
      }
    }

    const fullPrompt = `${contextText}${attachmentsContext ? `\n\nالمرفقات المضافة من الطالب بواسطة زر (+):${attachmentsContext}` : ''}`;
    parts.push({ text: fullPrompt });

    // AI Model: gemini-4-hydrogen with ThinkingLevel.LOW for fast, accurate Arabic tutoring
    const response = await getAiClient().models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: { parts },
      config: {
        systemInstruction: systemInstruction + '\nأنت معلم متميز يحبب الطالب في المذاكرة. عندما يرسل الطالب سؤالاً أو يرفق صورة، أو مسألة، أو فيديو، أو ملف، اشرحها بتفصيل وافٍ وخطوات واضحة وبسيطة، وحل أي سؤال أو تمرين بالسبب وبأسلوب محفز وممتع.',
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
      },
    });

    const reply = response.text || 'عذراً، لم أتمكن من استخراج الإجابة. يرجى تكرار السؤال أو صياغته بشكل أوضح.';

    return res.json({ reply });
  } catch (error: any) {
    console.error('AI Tutor API error:', error);
    return res.status(500).json({ 
      error: 'حدث خطأ أثناء التواصل مع المعلم الذكي. يرجى التأكد من كتابة السؤال والمحاولة مرة أخرى.',
      details: error?.message || 'Server error'
    });
  }
});

// AI Audio Explanation endpoint: Generates superior pedagogical Arabic explanation + real WAV audio
app.post('/api/ai-explain-page', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        error: 'خدمة الشرح الذكي غير مفعلة حالياً (مفتاح الذكاء الاصطناعي غير مضبوط).',
      });
    }

    const { docTitle, pageNumber, totalPages, subjectName, grade, pageImageUrl } = req.body || {};

    const promptText = `أنت «المعلم الذكي المتميز» الخبير في تدريس مناهج ${grade || 'المرحلة الابتدائية'} لمادة "${subjectName || 'الدراسية'}".
أمامك الصفحة رقم (${pageNumber || 1} من ${totalPages || 1}) من "${docTitle || 'المذكرة التعليمية'}".

المطلوب منك «شرح» هذه الصفحة شرحاً تعليمياً ممتعاً وتوضيح المفاهيم وليس مجرد قراءة نصية للكلمات المكتوبة:
1. الترحيب والتمهيد: ابدأ بترحيب تشجيعي لطيف بأسلوب المعلم المفضل للطلاب، وعرف الطالب بفكرة وموضوع الصفحة.
2. شرح الفكرة والمفاهيم بعمق وتبسيط: اشرح المفاهيم والمعاني العلمية أو اللغوية بأسلوبك التربوي الرائع، مع ضرب أمثلة من واقع حياة الطالب لتثبيت الفهم.
3. التوضيح والتعليل: وضح «لماذا وكيف» تم الوصول لهذه القواعد أو القوانين، ولا تكتفِ بسرد الكلام.
4. حل التمارين والمسائل خطوة بخطوة: إذا كانت هناك تدريبات أو مسائل أو أسئلة في الصفحة، اشرح طريقة الحل النموذجية مع ذكر السبب وراء كل خطوة.
5. نصيحة المعلم الذهبية: اختم بنصيحة ذكية وسريعة تساعد الطالب على تذكر الفكرة وحل أي امتحان بسهولة.

تذكر دائماً: اشرح ووضح وبسط، ولا تقرأ الكلام المكتوب فقط، بل علمه وفهمه كما يفعل المعلم الخصوصي في البيت!`;

    let requestContents: any = promptText;
    if (pageImageUrl && typeof pageImageUrl === 'string' && pageImageUrl.startsWith('data:image/')) {
      const match = pageImageUrl.match(/^data:(image\/[a-zA-Z0-9.+_-]+);base64,(.+)$/);
      if (match) {
        requestContents = {
          parts: [
            {
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            },
            {
              text: promptText,
            },
          ],
        };
      }
    }

    // 1. Generate high-quality explanation using gemini-4-hydrogen
    const response = await getAiClient().models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: requestContents,
      config: {
        systemInstruction: 'أنت المعلم الصوتي المتميز في منصة قلمي التعليمية. تشرح الدروس بأعلى جودة وإتقان وبأسلوب محفز وممتع للطلاب في شرح مركز وواضح لا يتجاوز 300 كلمة.',
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
      },
    });

    const explanation = response.text || 'أهلاً بك يا بطل! في هذه الصفحة نستعرض الدرس ونتعلم مفاهيمه الأساسية خطوة بخطوة.';

    // 2. Synthesize Real Audio (WAV) using gemini-3.8-flash-lite-tts
    let audioBase64: string | null = null;
    try {
      const speechScript = explanation
        .replace(/[*_#`~[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1600);

      const ttsResponse = await getAiClient().models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: speechScript,
                speechMetadata: {
                  style: 'Warm, clear, and cheerful Arabic teacher speaking to young students',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      audioBase64 = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
    } catch (ttsError: any) {
      console.warn('Gemini TTS synthesis note (client will use audio speech synthesis fallback):', ttsError?.message);
    }

    return res.json({ 
      explanation,
      audioBase64,
      audioMimeType: audioBase64 ? 'audio/wav' : null,
    });
  } catch (error: any) {
    console.error('AI Explain Page API error:', error);
    return res.status(500).json({
      error: 'تعذر توليد الشرح الصوتي حالياً. يرجى المحاولة مرة أخرى.',
      details: error?.message || 'Server error',
    });
  }
});

// Vite Middleware for development
if (process.env.NODE_ENV !== 'production') {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    plugins: [
      {
        name: 'disable-vite-client-websocket',
        enforce: 'post',
        transform(code, id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (
            normalizedId.endsWith('/vite/dist/client/client.mjs') ||
            normalizedId.endsWith('/@vite/client')
          ) {
            return {
              code: code
                .replace(
                  'transport.connect(createHMRHandler(handleMessage));',
                  '// Vite HMR WebSocket disabled'
                )
                .replace(
                  'setupForwardConsoleHandler(transport, forwardConsole);',
                  '// Forward console disabled'
                ),
              map: null,
            };
          }
        },
      },
    ],
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null,
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  // Serve static files in production
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
