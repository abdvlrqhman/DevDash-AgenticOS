import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect, RouterProvider } from '@tanstack/react-router'
import { AppShell } from './components/app/shell'
import { HomePage } from './features/home/HomePage'
import { ClaudeIndex, ClaudeLayout } from './features/claude/ClaudeLayout'

import { ApiError, meQuery } from './lib/api'
import { handleAppLinksAndDownloads, inShell } from './lib/shell'
import { getTheme, setTheme } from './lib/theme'
import './styles.css'

setTheme(getTheme())

// Inside the native app: behave like an app, not a web page (no zoom, no selecting UI text; see styles.css).
if (inShell()) {
  document.documentElement.classList.add('shell')
  document.querySelector('meta[name=viewport]')?.setAttribute('content',
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content')
  handleAppLinksAndDownloads()
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2 },
  },
})

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
// Every page but Home and Claude loads on first visit (or when a link to it is hovered), keeping the first load small.
const lazy = (load: () => Promise<Record<string, unknown>>, name: string) => lazyRouteComponent(load as never, name as never)

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  component: lazy(() => import('./features/auth/LoginPage'), 'LoginPage'),
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ to: '/' })
  },
})

const invite = createRoute({ getParentRoute: () => root, path: '/invite/$token', component: lazy(() => import('./features/auth/InvitePage'), 'InvitePage') })

const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  component: AppShell,
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/login' })
  },
})

const home = createRoute({ getParentRoute: () => app, path: '/', component: HomePage })
const members = createRoute({ getParentRoute: () => app, path: '/members', component: lazy(() => import('./features/members/MembersPage'), 'MembersPage') })
const terminal = createRoute({
  getParentRoute: () => app,
  path: '/terminal',
  component: lazyRouteComponent(() => import('./features/terminal/TerminalPage'), 'TerminalPage'), // xterm only loads here
  validateSearch: (s: Record<string, unknown>): { open?: string } => (typeof s.open === 'string' ? { open: s.open } : {}),
})
const account = createRoute({ getParentRoute: () => app, path: '/account', component: lazy(() => import('./features/account/AccountPage'), 'AccountPage') })
const more = createRoute({ getParentRoute: () => app, path: '/more', component: lazy(() => import('./features/more/MorePage'), 'MorePage') })
const projects = createRoute({ getParentRoute: () => app, path: '/projects', component: lazy(() => import('./features/projects/ProjectsPage'), 'ProjectsPage') })
const project = createRoute({ getParentRoute: () => app, path: '/projects/$slug', component: lazy(() => import('./features/projects/ProjectPage'), 'ProjectPage') })
// Team (optional)
const teamRole = createRoute({ getParentRoute: () => app, path: '/projects/$slug/team/$role', component: lazy(() => import('./features/team/RolePage'), 'RolePage') })
const approvals = createRoute({ getParentRoute: () => app, path: '/approvals', component: lazy(() => import('./features/team/Approvals'), 'ApprovalsPage') })
const approvalsProject = createRoute({ getParentRoute: () => app, path: '/approvals/$slug', component: lazy(() => import('./features/team/Approvals'), 'ApprovalsProjectPage') })
const teamThreads = createRoute({ getParentRoute: () => app, path: '/projects/$slug/team/threads', component: lazy(() => import('./features/team/ThreadsPage'), 'ThreadsPage') })
const teamThread = createRoute({ getParentRoute: () => app, path: '/projects/$slug/team/threads/$thread', component: lazy(() => import('./features/team/ThreadPage'), 'ThreadPage') })
const buildRun = createRoute({ getParentRoute: () => app, path: '/projects/$slug/builds/$run', component: lazy(() => import('./features/builds/RunPage'), 'RunPage') })
const tasks = createRoute({ getParentRoute: () => app, path: '/tasks', component: lazy(() => import('./features/tasks/TasksPage'), 'TasksPage') })
const task = createRoute({ getParentRoute: () => app, path: '/tasks/$slug/$number', component: lazy(() => import('./features/tasks/TaskPage'), 'TaskPage') })
const tools = createRoute({ getParentRoute: () => app, path: '/tools', component: lazy(() => import('./features/tools/ToolsPage'), 'ToolsPage') })
const tool = createRoute({ getParentRoute: () => app, path: '/tools/$tool', component: lazy(() => import('./features/tools/ToolsPage'), 'ToolPage') })
const notes = createRoute({ getParentRoute: () => app, path: '/notes', component: lazy(() => import('./features/notes/NotesPage'), 'NotesPage') })
const note = createRoute({
  getParentRoute: () => app,
  path: '/notes/$id',
  component: lazy(() => import('./features/notes/NotePage'), 'NotePage'),
  validateSearch: (s: Record<string, unknown>): { project?: string } => (typeof s.project === 'string' ? { project: s.project } : {}),
})
const files = createRoute({
  getParentRoute: () => app,
  path: '/files',
  component: lazy(() => import('./features/files/FilesPage'), 'FilesPage'),
  validateSearch: (s: Record<string, unknown>): { path?: string; tab?: 'links' } => ({
    ...(typeof s.path === 'string' ? { path: s.path } : {}), ...(s.tab === 'links' ? { tab: 'links' as const } : {}),
  }),
})
const serverRoute = createRoute({ getParentRoute: () => app, path: '/server', component: lazy(() => import('./features/status/ServerPage'), 'ServerPage') })
const browserRoute = createRoute({ getParentRoute: () => app, path: '/browser', component: lazy(() => import('./features/browser/BrowserPage'), 'BrowserPage') })
const vaultRoute = createRoute({ getParentRoute: () => app, path: '/vault', component: lazy(() => import('./features/vault/VaultPage'), 'VaultPage') })
const storage = createRoute({ getParentRoute: () => app, path: '/storage', component: lazy(() => import('./features/storage/StoragePage'), 'StoragePage') })
// Google sends the browser back here; outside the sign-in guard because the native app finishes in the system browser.
const storageCallback = createRoute({ getParentRoute: () => root, path: '/storage/callback', component: lazy(() => import('./features/storage/StoragePage'), 'StorageCallbackPage') })
const network = createRoute({ getParentRoute: () => app, path: '/network', component: lazy(() => import('./features/network/NetworkPage'), 'NetworkPage') })
const services = createRoute({ getParentRoute: () => app, path: '/services', component: lazyRouteComponent(() => import('./features/services/ServicesPage'), 'ServicesPage') })
const service = createRoute({ getParentRoute: () => app, path: '/services/$name', component: lazyRouteComponent(() => import('./features/services/ServicePage'), 'ServicePage') })
// A service inside the app, framed under the top bar (the Service page's "View", and pinned services).
const serviceView = createRoute({ getParentRoute: () => app, path: '/services/$name/view', component: lazyRouteComponent(() => import('./features/services/ServiceViewPage'), 'ServiceViewPage') })
// Claude is master-detail on wide screens: ClaudeLayout keeps the session list beside whatever is open.
const claude = createRoute({ getParentRoute: () => app, path: '/claude', component: ClaudeLayout })
const claudeIndex = createRoute({ getParentRoute: () => claude, path: '/', component: ClaudeIndex })
const claudeSetup = createRoute({ getParentRoute: () => claude, path: '/setup', component: lazy(() => import('./features/claude/SetupPage'), 'SetupPage') })
const claudeSession = createRoute({
  getParentRoute: () => claude,
  path: '/$id',
  component: lazyRouteComponent(() => import('./features/claude/SessionPage'), 'SessionPage'), // markdown + xterm load here
})

const router = createRouter({
  routeTree: root.addChildren([login, invite, storageCallback, app.addChildren([home, claude.addChildren([claudeIndex, claudeSetup, claudeSession]), terminal, files, vaultRoute, network, storage, browserRoute, serverRoute, services, service, serviceView, projects, project, teamRole, teamThreads, teamThread, approvals, approvalsProject, buildRun, tasks, task, tools, tool, notes, note, members, account, more])]),
  context: { queryClient },
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
