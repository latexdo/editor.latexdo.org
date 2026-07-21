interface Env {
  ASSETS: Fetcher;
}

// Cloudflare still has historical Durable Object metadata for this Worker.
// Keep this export so preview-only deploys can replace the Worker without
// reintroducing the old container-backed backend binding.
export class LatexDoBackend {
  async fetch(): Promise<Response> {
    return new Response(
      "The LatexDo backend is disabled in this preview deployment.",
      {
        status: 410,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
}

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface PreviewProject {
  meta: ProjectMeta;
  files: Map<string, string>;
  folders: Set<string>;
}

interface PreviewSession {
  currentProjectId: string;
  projects: Map<string, PreviewProject>;
}

interface ProjectEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: ProjectEntry[];
}

const sessions = new Map<string, PreviewSession>();
const previewProjectName = "LatexDo Preview";

const starterDocument = String.raw`\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{microtype}
\usepackage{hyperref}

\title{LatexDo Preview}
\author{}
\date{\today}

\begin{document}

\maketitle

\section{Welcome}

This preview deploy is intentionally static. The editor, file tree,
settings, templates, snippets, and local writing tools are available.

\section{Compilation}

Hosted PDF compilation is disabled for this preview so the site can deploy
without the LaTeX container backend.

\end{document}
`;

const referencesBib = String.raw`@misc{latexdo-preview,
  title = {LatexDo Preview},
  author = {LatexDo},
  year = {2026}
}
`;

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const response = await env.ASSETS.fetch(request);

  if (
    response.ok &&
    url.pathname.startsWith("/assets/index-") &&
    url.pathname.endsWith(".js")
  ) {
    const body = await response.text();
    const rewritten = body.replaceAll(
      "\"https://editor.latexdo.org\"",
      "window.location.origin",
    );
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/javascript; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.delete("content-length");
    return new Response(rewritten, { status: response.status, headers });
  }

  return response;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function normalizeSessionId(request: Request): string {
  return (
    request.headers
      .get("x-latexdo-session")
      ?.trim()
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 96) || "anonymous"
  );
}

function normalizeProjectId(value: string): string {
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(value)) {
    throw new Error("Invalid project id.");
  }
  return value;
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Path is required.");
  }

  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)\.\//g, "$1")
    .replace(/\/+$/, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("Use a relative path inside the project.");
  }

  return normalized;
}

function fileName(relativePath: string): string {
  return relativePath.split("/").pop() || relativePath;
}

function parentPath(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function openProject(meta: ProjectMeta) {
  return {
    id: meta.id,
    name: meta.name,
    rootPath: `cloud://latexdo/${meta.id}/${encodeURIComponent(meta.name)}`,
  };
}

function stablePreviewProjectId(sessionId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `preview-${(hash >>> 0).toString(36)}`;
}

function createPreviewProject(
  name = previewProjectName,
  id: string = crypto.randomUUID(),
): PreviewProject {
  const now = Date.now();
  const meta = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
  };
  return {
    meta,
    folders: new Set(["sections"]),
    files: new Map([
      ["main.tex", starterDocument],
      ["references.bib", referencesBib],
      [
        "sections/notes.tex",
        "% Add notes here. This file is included to show the project tree.\n",
      ],
    ]),
  };
}

function getSession(request: Request): PreviewSession {
  const sessionId = normalizeSessionId(request);
  let session = sessions.get(sessionId);

  if (!session) {
    const project = createPreviewProject(
      previewProjectName,
      stablePreviewProjectId(sessionId),
    );
    session = {
      currentProjectId: project.meta.id,
      projects: new Map([[project.meta.id, project]]),
    };
    sessions.set(sessionId, session);
  }

  return session;
}

function getProject(session: PreviewSession, projectId: string): PreviewProject {
  const normalizedProjectId = normalizeProjectId(projectId);
  const project = session.projects.get(normalizedProjectId);
  if (!project) throw new Error("The requested preview project does not exist.");
  return project;
}

function touch(session: PreviewSession, project: PreviewProject): void {
  const now = Date.now();
  project.meta = { ...project.meta, updatedAt: now };
  session.currentProjectId = project.meta.id;
}

function ensureParentFolders(project: PreviewProject, relativePath: string): void {
  let current = "";
  for (const part of parentPath(relativePath).split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    project.folders.add(current);
  }
}

function starterContent(relativePath: string): string {
  if (fileName(relativePath) === "main.tex") return starterDocument;
  if (relativePath.endsWith(".bib")) return "% Add BibTeX entries here.\n";
  return "";
}

function listProjectEntries(project: PreviewProject): ProjectEntry[] {
  const root: ProjectEntry[] = [];
  const directories = new Map<string, ProjectEntry>();

  const childrenFor = (relativePath: string): ProjectEntry[] => {
    if (!relativePath) return root;
    let directory = directories.get(relativePath);
    if (!directory) {
      const parent = parentPath(relativePath);
      directory = {
        name: fileName(relativePath),
        path: relativePath,
        relativePath,
        type: "directory",
        children: [],
      };
      directories.set(relativePath, directory);
      childrenFor(parent).push(directory);
    }
    return directory.children ?? [];
  };

  for (const folder of [...project.folders].sort()) {
    childrenFor(folder);
  }

  for (const relativePath of [...project.files.keys()].sort()) {
    childrenFor(parentPath(relativePath)).push({
      name: fileName(relativePath),
      path: relativePath,
      relativePath,
      type: "file",
    });
  }

  const sortEntries = (entries: ProjectEntry[]): ProjectEntry[] => {
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const entry of entries) {
      if (entry.children) sortEntries(entry.children);
    }
    return entries;
  };

  return sortEntries(root);
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function moveEntry(
  project: PreviewProject,
  fromRelativePath: string,
  toRelativePath: string,
): void {
  if (fromRelativePath === toRelativePath) return;
  if (project.files.has(toRelativePath) || project.folders.has(toRelativePath)) {
    throw new Error(`"${toRelativePath}" already exists.`);
  }

  const fileContent = project.files.get(fromRelativePath);
  if (fileContent !== undefined) {
    project.files.delete(fromRelativePath);
    project.files.set(toRelativePath, fileContent);
    ensureParentFolders(project, toRelativePath);
    return;
  }

  if (!project.folders.has(fromRelativePath)) {
    throw new Error("The requested file or folder does not exist.");
  }
  if (toRelativePath.startsWith(`${fromRelativePath}/`)) {
    throw new Error("Cannot move a folder into itself.");
  }

  const movedFiles = [...project.files.entries()].filter(
    ([path]) => path === fromRelativePath || path.startsWith(`${fromRelativePath}/`),
  );
  const movedFolders = [...project.folders].filter(
    (path) => path === fromRelativePath || path.startsWith(`${fromRelativePath}/`),
  );

  for (const path of movedFiles.map(([path]) => path)) project.files.delete(path);
  for (const path of movedFolders) project.folders.delete(path);
  for (const path of movedFolders) {
    project.folders.add(path.replace(fromRelativePath, toRelativePath));
  }
  for (const [path, content] of movedFiles) {
    project.files.set(path.replace(fromRelativePath, toRelativePath), content);
  }
  ensureParentFolders(project, toRelativePath);
}

async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const session = getSession(request);

  try {
    if (url.pathname === "/api/health") {
      return json({ ok: true, preview: true });
    }

    if (url.pathname === "/api/projects" && method === "GET") {
      return json({ projects: [...session.projects.values()].map((project) => project.meta) });
    }

    if (url.pathname === "/api/projects" && method === "POST") {
      const body = await requestBody(request);
      const folderName = typeof body.folderName === "string" ? body.folderName.trim() : "";
      const project = createPreviewProject(folderName || "LatexDo Preview Project");
      session.projects.set(project.meta.id, project);
      touch(session, project);
      return json(openProject(project.meta));
    }

    if (url.pathname === "/api/projects/open" && method === "POST") {
      const project =
        session.projects.get(session.currentProjectId) ??
        [...session.projects.values()][0] ??
        createPreviewProject();
      session.projects.set(project.meta.id, project);
      touch(session, project);
      return json(openProject(project.meta));
    }

    const shareMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/share$/);
    if (shareMatch && method === "GET") {
      return json({ enabled: false, users: [] });
    }
    if (shareMatch && method === "POST") {
      return error(501, "Collaboration links are not enabled in the preview deployment.");
    }

    const shareOpenMatch = url.pathname.match(/^\/api\/shares\/([^/]+)\/open$/);
    if (shareOpenMatch && method === "POST") {
      return error(501, "Shared project links are not enabled in the preview deployment.");
    }

    const sharePresenceMatch = url.pathname.match(/^\/api\/shares\/([^/]+)\/presence$/);
    if (sharePresenceMatch && method === "POST") {
      return json({ enabled: false, users: [] });
    }

    const filesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/files(?:\/([^/]+))?$/);
    if (filesMatch) {
      const project = getProject(session, decodeURIComponent(filesMatch[1]));
      const action = filesMatch[2] ?? "";

      if (!action && method === "GET") {
        return json(listProjectEntries(project));
      }

      if (!action && method === "POST") {
        const body = await requestBody(request);
        const relativePath = normalizeRelativePath(body.relativePath);
        if (body.type === "directory") {
          project.folders.add(relativePath);
        } else if (body.type === "file") {
          ensureParentFolders(project, relativePath);
          if (!project.files.has(relativePath)) {
            project.files.set(relativePath, starterContent(relativePath));
          }
        } else {
          throw new Error("File type must be file or directory.");
        }
        touch(session, project);
        return json({ relativePath });
      }

      if (action === "content" && method === "GET") {
        const relativePath = normalizeRelativePath(url.searchParams.get("path"));
        const content = project.files.get(relativePath);
        if (content === undefined) throw new Error("The requested file does not exist.");
        return json({ content });
      }

      if (action === "content" && method === "PUT") {
        const relativePath = normalizeRelativePath(url.searchParams.get("path"));
        const body = await requestBody(request);
        const content = typeof body.content === "string" ? body.content : "";
        ensureParentFolders(project, relativePath);
        project.files.set(relativePath, content);
        touch(session, project);
        return json({});
      }

      if (action === "exists" && method === "GET") {
        const relativePath = normalizeRelativePath(url.searchParams.get("path"));
        return json({
          exists: project.files.has(relativePath) || project.folders.has(relativePath),
        });
      }

      if (action === "move" && method === "POST") {
        const body = await requestBody(request);
        const fromRelativePath = normalizeRelativePath(body.fromRelativePath);
        const toRelativePath = normalizeRelativePath(body.toRelativePath);
        moveEntry(project, fromRelativePath, toRelativePath);
        touch(session, project);
        return json({ relativePath: toRelativePath });
      }

      if (action === "blob" && method === "PUT") {
        const relativePath = normalizeRelativePath(url.searchParams.get("path"));
        const body = await requestBody(request);
        const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
        ensureParentFolders(project, relativePath);
        project.files.set(relativePath, "");
        touch(session, project);
        return json({ relativePath, size: contentBase64.length });
      }
    }

    if (url.pathname === "/api/compile" && method === "POST") {
      const body = await requestBody(request);
      const rootFile = typeof body.rootFile === "string" ? body.rootFile : "main.tex";
      return json({
        ok: false,
        durationMs: 0,
        output:
          "PDF compilation is disabled in this preview deployment.\nThe editor preview is running without the LaTeX container backend.",
        diagnostics: [
          {
            file: rootFile,
            line: 1,
            column: 1,
            severity: "warning",
            message: "PDF compilation is disabled in this preview deployment.",
            detail: "This site deploys only the editor preview and static Worker API stub.",
            source: "latex",
          },
        ],
        error: "Preview deployment only.",
      });
    }

    if (url.pathname.startsWith("/api/import/")) {
      return error(501, "Document import is not enabled in the preview deployment.");
    }

    if (/^\/api\/projects\/[^/]+\/(?:pdf|asset)$/.test(url.pathname)) {
      return error(404, "Preview deployment does not serve generated PDFs or binary assets.");
    }

    return error(404, "Preview API endpoint not found.");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Preview API request failed.";
    return error(400, message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request);
    }

    return serveAsset(request, env);
  },
};
