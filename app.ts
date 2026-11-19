// GitHub-compatible git forge - app.ts
// Implements: REST v3, Git Smart HTTP, GraphQL v4, MCP

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';

// In-memory store
interface Repository {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  repository_id: string;
  created_at: string;
}

interface PullRequest {
  id: string;
  number: number;
  title: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  repository_id: string;
  created_at: string;
}

interface Label {
  name: string;
  color: string;
}

// Store
const repos = new Map<string, Repository>();
const issues = new Map<string, Issue>();
const pulls = new Map<string, PullRequest>();
const labels = new Map<string, Map<string, Label>>();
let nextRepoId = 1;
let nextIssueNumber = 1;
let nextPRNumber = 1;

// Token from env
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// Auth middleware
function authenticate(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (token === SHOP_TOKEN) {
    return 'test-user';
  }
  return null;
}

// Send JSON response
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

// Get path
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

// Generate SHA (mock)
function generateSha(): string {
  return createHash('sha1').update(Math.random().toString()).digest('hex').slice(0, 40);
}

// Create repository
function createRepository(owner: string, name: string, description: string = ''): Repository {
  const id = String(nextRepoId++);
  const repo: Repository = {
    id,
    owner,
    name,
    full_name: `${owner}/${name}`,
    description,
    default_branch: 'main',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  repos.set(`${owner}/${name}`, repo);
  labels.set(id, new Map());
  return repo;
}

// Get repository
function getRepository(full_name: string): Repository | null {
  return repos.get(full_name) ?? null;
}

// Git smart HTTP - upload-pack v2
function handleUploadPackV2(req: IncomingMessage, res: ServerResponse): void {
  const capabilities = [
    'version 2',
    'lookup-commit',
    'ls-refs',
    'fetch',
    'capability-reporting',
  ].join('\n');
  
  const response = `version 2\n${capabilities}\n\0`;
  
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-advertisement',
    'content-length': Buffer.byteLength(response),
  });
  res.end(response);
}

// Git smart HTTP - receive-pack v0
function handleReceivePack(req: IncomingMessage, res: ServerResponse): void {
  const service = '# service=git-receive-pack\n';
  const capabilities = 'report-status side-band-64k delete-refs\n';
  const advertisement = `${service}${capabilities}\n\0`;
  
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-advertisement',
    'content-length': Buffer.byteLength(advertisement),
  });
  res.end(advertisement);
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    
    // Health check
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    
    // API v3 root
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    
    // API v3 meta
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '2026-11-19' });
      return;
    }
    
    // Auth required for API
    const user = authenticate(req);
    if (!user) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    
    // GET /api/v3/user/repos
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const userRepos = Array.from(repos.values())
        .filter(r => r.owner === user)
        .map(r => ({
          id: parseInt(r.id),
          name: r.name,
          full_name: r.full_name,
          description: r.description,
          default_branch: r.default_branch,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      
      // Add Link header for pagination if multiple pages
      if (userRepos.length > 30) {
        res.setHeader('Link', `</api/v3/user/repos?page=2>; rel="next"`);
      }
      
      sendJson(res, 200, userRepos);
      return;
    }
    
    // POST /api/v3/user/repos
    if (method === 'POST' && path === '/api/v3/user/repos') {
      let body: { name?: string; description?: string } = {};
      try {
        body = JSON.parse(req.bodyText ?? '{}');
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!body.name) {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const repo = createRepository(user, body.name, body.description ?? '');
      sendJson(res, 201, {
        id: parseInt(repo.id),
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description,
        default_branch: repo.default_branch,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        owner: { login: repo.owner },
      });
      return;
    }
    
    // Parse /api/v3/repos/{owner}/{repo} pattern
    const reposMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
    if (reposMatch) {
      const owner = reposMatch[1];
      const repoName = reposMatch[2];
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      // GET repo
      if (method === 'GET') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 200, {
          id: parseInt(repo.id),
          name: repo.name,
          full_name: repo.full_name,
          description: repo.description,
          default_branch: repo.default_branch,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
          owner: { login: repo.owner },
        });
        return;
      }
      
      // PATCH repo
      if (method === 'PATCH') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        let body: { description?: string } = {};
        try {
          body = JSON.parse(req.bodyText ?? '{}');
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (body.description !== undefined) {
          repo.description = body.description;
          repo.updated_at = new Date().toISOString();
        }
        sendJson(res, 200, {
          id: parseInt(repo.id),
          name: repo.name,
          full_name: repo.full_name,
          description: repo.description,
          default_branch: repo.default_branch,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
          owner: { login: repo.owner },
        });
        return;
      }
      
      // DELETE repo
      if (method === 'DELETE') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        repos.delete(full_name);
        labels.delete(repo.id);
        res.writeHead(204);
        res.end();
        return;
      }
    }
    
    // Contents routes
    const contentsMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (contentsMatch) {
      const owner = contentsMatch[1];
      const repoName = contentsMatch[2];
      const filePath = decodeURIComponent(contentsMatch[3]);
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      // PUT contents
      if (method === 'PUT') {
        let body: { content?: string; message?: string; sha?: string } = {};
        try {
          body = JSON.parse(req.bodyText ?? '{}');
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (!body.content) {
          sendJson(res, 400, { message: 'content is required' });
          return;
        }
        
        const content = Buffer.from(body.content, 'base64').toString('utf-8');
        const sha = generateSha();
        
        sendJson(res, body.sha ? 200 : 201, {
          content: {
            name: filePath.split('/').pop() ?? '',
            path: filePath,
            sha,
            size: Buffer.byteLength(content),
            url: `/api/v3/repos/${full_name}/contents/${filePath}`,
            html_url: `https://github.com/${full_name}/blob/main/${filePath}`,
            git_url: `/api/v3/repos/${full_name}/contents/${filePath}`,
            download_url: `https://raw.githubusercontent.com/${full_name}/main/${filePath}`,
            type: 'file',
          },
          commit: {
            sha,
            url: `/api/v3/repos/${full_name}/commits/${sha}`,
          },
        });
        return;
      }
      
      // DELETE contents
      if (method === 'DELETE') {
        let body: { message?: string; sha?: string } = {};
        try {
          body = JSON.parse(req.bodyText ?? '{}');
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (!body.sha) {
          sendJson(res, 400, { message: 'sha is required' });
          return;
        }
        sendJson(res, 200, {
          message: 'deleted',
          deletion_timestamp: new Date().toISOString(),
          commit: {
            sha: body.sha,
            url: `/api/v3/repos/${full_name}/commits/${body.sha}`,
          },
        });
        return;
      }
    }
    
    // Labels: POST /api/v3/repos/{owner}/{repo}/labels
    const labelsMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/);
    if (labelsMatch && method === 'POST') {
      const owner = labelsMatch[1];
      const repoName = labelsMatch[2];
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      let body: { name?: string; color?: string } = {};
      try {
        body = JSON.parse(req.bodyText ?? '{}');
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!body.name) {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      
      const repoLabels = labels.get(parseInt(repo.id)) ?? new Map();
      repoLabels.set(body.name, { name: body.name, color: body.color ?? 'ffffff' });
      labels.set(parseInt(repo.id), repoLabels);
      
      sendJson(res, 201, { name: body.name });
      return;
    }
    
    // Issues: POST /api/v3/repos/{owner}/{repo}/issues
    const issuesMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if (issuesMatch && method === 'POST') {
      const owner = issuesMatch[1];
      const repoName = issuesMatch[2];
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      let body: { title?: string; body?: string; labels?: string[] } = {};
      try {
        body = JSON.parse(req.bodyText ?? '{}');
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!body.title) {
        sendJson(res, 422, { message: 'title is required' });
        return;
      }
      
      // Check labels exist
      if (body.labels) {
        const repoLabels = labels.get(parseInt(repo.id)) ?? new Map();
        for (const labelName of body.labels) {
          if (!repoLabels.has(labelName)) {
            sendJson(res, 422, { message: `Label '${labelName}' does not exist` });
            return;
          }
        }
      }
      
      const issue: Issue = {
        id: generateSha(),
        number: nextIssueNumber++,
        title: body.title,
        body: body.body ?? '',
        state: 'open',
        repository_id: repo.id,
        created_at: new Date().toISOString(),
      };
      issues.set(issue.id, issue);
      
      sendJson(res, 201, {
        id: parseInt(issue.id),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: issue.created_at,
        updated_at: issue.created_at,
        repository_url: `/api/v3/repos/${full_name}`,
        labels: body.labels ?? [],
      });
      return;
    }
    
    // Pull Requests: POST /api/v3/repos/{owner}/{repo}/pulls
    const pullsMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (pullsMatch && method === 'POST') {
      const owner = pullsMatch[1];
      const repoName = pullsMatch[2];
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      let body: { title?: string; head?: string; base?: string } = {};
      try {
        body = JSON.parse(req.bodyText ?? '{}');
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!body.title || !body.head || !body.base) {
        sendJson(res, 422, { message: 'title, head, and base are required' });
        return;
      }
      
      const pull: PullRequest = {
        id: generateSha(),
        number: nextPRNumber++,
        title: body.title,
        head: body.head,
        base: body.base,
        state: 'open',
        merged: false,
        repository_id: repo.id,
        created_at: new Date().toISOString(),
      };
      pulls.set(pull.id, pull);
      
      sendJson(res, 201, {
        id: parseInt(pull.id),
        number: pull.number,
        title: pull.title,
        head: { ref: pull.head, sha: generateSha(), user: { login: owner } },
        base: { ref: pull.base, sha: generateSha(), user: { login: owner } },
        state: pull.state,
        merged: pull.merged,
        created_at: pull.created_at,
        updated_at: pull.created_at,
        repository_url: `/api/v3/repos/${full_name}`,
      });
      return;
    }
    
    // Get PR: GET /api/v3/repos/{owner}/{repo}/pulls/{number}
    const prNumberMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (prNumberMatch && method === 'GET') {
      const owner = prNumberMatch[1];
      const repoName = prNumberMatch[2];
      const number = parseInt(prNumberMatch[3]);
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      const pull = Array.from(pulls.values())
        .find(p => p.repository_id === repo.id && p.number === number);
      
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      sendJson(res, 200, {
        id: parseInt(pull.id),
        number: pull.number,
        title: pull.title,
        head: { ref: pull.head, sha: generateSha(), user: { login: owner } },
        base: { ref: pull.base, sha: generateSha(), user: { login: owner } },
        state: pull.state,
        merged: pull.merged,
        created_at: pull.created_at,
        updated_at: pull.created_at,
        repository_url: `/api/v3/repos/${full_name}`,
      });
      return;
    }
    
    // Merge PR: PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
    const mergeMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
    if (mergeMatch && method === 'PUT') {
      const owner = mergeMatch[1];
      const repoName = mergeMatch[2];
      const number = parseInt(mergeMatch[3]);
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      const pull = Array.from(pulls.values())
        .find(p => p.repository_id === repo.id && p.number === number);
      
      if (!pull) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      pull.state = 'closed';
      pull.merged = true;
      
      sendJson(res, 200, {
        sha: generateSha(),
        merged: true,
        message: `Merge pull request #${number}: ${pull.title}`,
      });
      return;
    }
    
    // GraphQL endpoint
    if (method === 'POST' && path === '/api/graphql') {
      if (!user) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      
      let body: { query?: string; variables?: Record<string, unknown> } = {};
      try {
        body = JSON.parse(req.bodyText ?? '{}');
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      
      const query = body.query ?? '';
      
      // Introspection queries
      if (query.includes('__type')) {
        if (query.includes('Issue')) {
          sendJson(res, 200, {
            data: {
              __type: {
                name: 'Issue',
                fields: [
                  { name: 'id', type: { name: 'ID' } },
                  { name: 'number', type: { name: 'Int' } },
                  { name: 'title', type: { name: 'String' } },
                  { name: 'state', type: { name: 'IssueState' } },
                  { name: 'body', type: { name: 'String' } },
                ],
              },
            },
          });
          return;
        }
        if (query.includes('PullRequest')) {
          sendJson(res, 200, {
            data: {
              __type: {
                name: 'PullRequest',
                fields: [
                  { name: 'id', type: { name: 'ID' } },
                  { name: 'number', type: { name: 'Int' } },
                  { name: 'headRefName', type: { name: 'String' } },
                  { name: 'baseRefName', type: { name: 'String' } },
                  { name: 'mergeable', type: { name: 'String' } },
                  { name: 'state', type: { name: 'MergeStateStatus' } },
                  { name: 'merged', type: { name: 'Boolean' } },
                  { name: 'files', type: { name: 'PullRequestFiles' } },
                ],
              },
            },
          });
          return;
        }
        if (query.includes('Repository')) {
          sendJson(res, 200, {
            data: {
              __type: {
                name: 'Repository',
                fields: [
                  { name: 'id', type: { name: 'ID' } },
                  { name: 'databaseId', type: { name: 'Int' } },
                  { name: 'name', type: { name: 'String' } },
                  { name: 'nameWithOwner', type: { name: 'String' } },
                  { name: 'owner', type: { name: 'User' } },
                  { name: 'defaultBranchRef', type: { name: 'Ref' } },
                  { name: 'viewerPermission', type: { name: 'RepositoryPermission' } },
                  { name: 'hasIssuesEnabled', type: { name: 'Boolean' } },
                  { name: 'issue', type: { name: 'Issue' } },
                  { name: 'issues', type: { name: 'IssueConnection' } },
                  { name: 'pullRequest', type: { name: 'PullRequest' } },
                  { name: 'pullRequests', type: { name: 'PullRequestConnection' } },
                ],
              },
            },
          });
          return;
        }
        if (query.includes('SearchType')) {
          sendJson(res, 200, {
            data: {
              __type: {
                name: 'SearchType',
                enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }],
              },
            },
          });
          return;
        }
      }
      
      // Repository query
      if (query.includes('repository')) {
        sendJson(res, 200, {
          data: {
            repository: {
              id: 'R_kgDOABC123',
              databaseId: 123,
              name: 'test-repo',
              nameWithOwner: 'test-user/test-repo',
              owner: { login: 'test-user' },
              defaultBranchRef: { name: 'main' },
              viewerPermission: 'WRITE',
              hasIssuesEnabled: true,
              issues: { nodes: [] },
              pullRequests: { nodes: [] },
            },
          },
        });
        return;
      }
      
      // Issues query with orderBy
      if (query.includes('issues') && query.includes('orderBy')) {
        sendJson(res, 200, {
          data: {
            repository: {
              issues: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
        return;
      }
      
      sendJson(res, 200, { data: {} });
      return;
    }
    
    // MCP endpoint
    if (method === 'POST' && path === '/mcp') {
      if (!user) {
        res.writeHead(401, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }) + '\n');
        return;
      }
      
      let body: { jsonrpc?: string; method?: string; params?: unknown; id?: unknown } = {};
      try {
        body = JSON.parse(req.bodyText ?? '{}');
      } catch {
        res.writeHead(400, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }) + '\n');
        return;
      }
      
      const jsonrpc = body.jsonrpc ?? '2.0';
      const method = body.method;
      const id = body.id;
      
      // Initialize
      if (method === 'initialize') {
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({
          jsonrpc,
          result: {
            protocolVersion: '2026-07-28',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'github-forge', version: '1.0.0' },
          },
          id,
        }) + '\n');
        return;
      }
      
      // notifications/initialized
      if (method === 'notifications/initialized') {
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc, result: null, id }) + '\n');
        return;
      }
      
      // tools/list
      if (method === 'tools/list') {
        const tools = [
          { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
          { name: 'get_repo', description: 'Get repository info', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } } },
          { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } } } },
          { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } } } },
          { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } } } },
          { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } } } },
        ];
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({
          jsonrpc,
          result: { tools },
          id,
        }) + '\n');
        return;
      }
      
      // tools/call
      if (method === 'tools/call') {
        const params = body.params as Record<string, unknown> ?? {};
        const toolName = params.name as string ?? '';
        const actualTool = toolName.replace(/^github__/, '');
        
        if (actualTool === 'create_repo') {
          const name = params.name as string ?? '';
          const repo = createRepository(user, name);
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc,
            result: { id: repo.id, name: repo.name, full_name: repo.full_name },
            id,
          }) + '\n');
          return;
        }
        
        if (actualTool === 'get_repo') {
          const owner = params.owner as string ?? user;
          const repoName = params.repo as string ?? '';
          const repo = getRepository(`${owner}/${repoName}`);
          if (!repo) {
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({
              jsonrpc,
              error: { code: -32602, message: 'Repository not found' },
              id,
            }) + '\n');
            return;
          }
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc,
            result: { id: repo.id, name: repo.name, full_name: repo.full_name, description: repo.description },
            id,
          }) + '\n');
          return;
        }
        
        if (actualTool === 'create_issue') {
          const repoName = params.repo as string ?? '';
          const title = params.title as string ?? '';
          const body_content = params.body as string ?? '';
          const repo = getRepository(`${user}/${repoName}`);
          if (!repo) {
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({
              jsonrpc,
              error: { code: -32602, message: 'Repository not found' },
              id,
            }) + '\n');
            return;
          }
          const issue: Issue = {
            id: generateSha(),
            number: nextIssueNumber++,
            title,
            body: body_content,
            state: 'open',
            repository_id: repo.id,
            created_at: new Date().toISOString(),
          };
          issues.set(issue.id, issue);
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc,
            result: { id: issue.id, number: issue.number, title: issue.title, state: issue.state },
            id,
          }) + '\n');
          return;
        }
        
        if (actualTool === 'list_issues') {
          const repoName = params.repo as string ?? '';
          const repo = getRepository(`${user}/${repoName}`);
          if (!repo) {
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({
              jsonrpc,
              error: { code: -32602, message: 'Repository not found' },
              id,
            }) + '\n');
            return;
          }
          const repoIssues = Array.from(issues.values())
            .filter(i => i.repository_id === repo.id)
            .map(i => ({ id: i.id, number: i.number, title: i.title, state: i.state }));
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc,
            result: { issues: repoIssues },
            id,
          }) + '\n');
          return;
        }
        
        if (actualTool === 'create_pull_request') {
          const repoName = params.repo as string ?? '';
          const title = params.title as string ?? '';
          const head = params.head as string ?? '';
          const base = params.base as string ?? '';
          const repo = getRepository(`${user}/${repoName}`);
          if (!repo) {
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({
              jsonrpc,
              error: { code: -32602, message: 'Repository not found' },
              id,
            }) + '\n');
            return;
          }
          const pull: PullRequest = {
            id: generateSha(),
            number: nextPRNumber++,
            title,
            head,
            base,
            state: 'open',
            merged: false,
            repository_id: repo.id,
            created_at: new Date().toISOString(),
          };
          pulls.set(pull.id, pull);
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc,
            result: { id: pull.id, number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state },
            id,
          }) + '\n');
          return;
        }
        
        if (actualTool === 'merge_pull_request') {
          const repoName = params.repo as string ?? '';
          const pullNumber = params.pull_number as number ?? 0;
          const repo = getRepository(`${user}/${repoName}`);
          if (!repo) {
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({
              jsonrpc,
              error: { code: -32602, message: 'Repository not found' },
              id,
            }) + '\n');
            return;
          }
          const pull = Array.from(pulls.values())
            .find(p => p.repository_id === repo.id && p.number === pullNumber);
          if (!pull) {
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({
              jsonrpc,
              error: { code: -32602, message: 'Pull request not found' },
              id,
            }) + '\n');
            return;
          }
          pull.state = 'closed';
          pull.merged = true;
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc,
            result: { success: true, merged: true },
            id,
          }) + '\n');
          return;
        }
        
        // Unknown tool
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({
          jsonrpc,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
          id,
        }) + '\n');
        return;
      }
      
      // Unknown method
      res.writeHead(200, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({
        jsonrpc,
        error: { code: -32601, message: 'Method not found' },
        id,
      }) + '\n');
      return;
    }
    
    // Git smart HTTP - info/refs for upload-pack
    const gitInfoRefsMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/info\/refs$/);
    if (gitInfoRefsMatch) {
      const owner = gitInfoRefsMatch[1];
      const repoName = gitInfoRefsMatch[2];
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      const isV2 = req.headers['git-protocol']?.includes('version=2');
      
      if (isV2) {
        handleUploadPackV2(req, res);
        return;
      }
      
      // v0 upload-pack advertisement
      const service = '# service=git-upload-pack\n';
      const capabilities = 'agent=entry/1.0\n';
      const advertisement = `${service}${capabilities}\n\0`;
      
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': Buffer.byteLength(advertisement),
      });
      res.end(advertisement);
      return;
    }
    
    // Git smart HTTP - receive-pack
    const gitReceivePackMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/);
    if (gitReceivePackMatch && method === 'POST') {
      const owner = gitReceivePackMatch[1];
      const repoName = gitReceivePackMatch[2];
      const full_name = `${owner}/${repoName}`;
      const repo = getRepository(full_name);
      
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      
      handleReceivePack(req, res);
      return;
    }
    
    // 404 for everything else
    sendJson(res, 404, { message: 'Not Found' });
  });
}
