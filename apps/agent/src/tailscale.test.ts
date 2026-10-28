import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimStatus } from './tailscale.ts'

const ports = { socksPort: 41000, httpPort: 41001 }

test('trimStatus: a logged-out node (NeedsLogin) has no self IP and no devices', () => {
  const raw = { BackendState: 'NeedsLogin', Self: { HostName: 'devdash-ann', TailscaleIPs: [] }, Peer: {} }
  const s = trimStatus(raw, ports)
  assert.equal(s.backendState, 'NeedsLogin')
  assert.equal(s.running, true)
  assert.deepEqual(s.self, { hostName: 'devdash-ann', tailscaleIPs: [] })
  assert.deepEqual(s.devices, [])
  assert.equal(s.socksPort, 41000)
  assert.equal(s.httpPort, 41001)
})

test('trimStatus: a running node trims peers and sorts online first', () => {
  const raw = {
    BackendState: 'Running',
    Self: { HostName: 'devdash-ann', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] },
    Peer: {
      'key-b': { HostName: 'ida-box', DNSName: 'ida-box.tail1234.ts.net.', OS: 'linux', TailscaleIPs: ['100.64.0.3'], Online: false, LastSeen: '2026-10-11T09:00:00Z' },
      'key-a': { HostName: 'iphone', DNSName: 'iphone.tail1234.ts.net.', OS: 'iOS', TailscaleIPs: ['100.64.0.2', 'fd7a::2'], Online: true, LastSeen: '2026-10-12T10:00:00Z' },
    },
  }
  const s = trimStatus(raw, ports)
  assert.equal(s.backendState, 'Running')
  assert.deepEqual(s.self, { hostName: 'devdash-ann', tailscaleIPs: ['100.64.0.1', 'fd7a::1'] })
  // online first, then by name; dns trailing dot removed; first IP kept
  assert.deepEqual(s.devices, [
    { name: 'iphone', dnsName: 'iphone.tail1234.ts.net', os: 'iOS', ip: '100.64.0.2', online: true, lastSeen: '2026-10-12T10:00:00Z' },
    { name: 'ida-box', dnsName: 'ida-box.tail1234.ts.net', os: 'linux', ip: '100.64.0.3', online: false, lastSeen: '2026-10-11T09:00:00Z' },
  ])
})

test('trimStatus: tolerates missing fields', () => {
  const s = trimStatus({}, ports)
  assert.equal(s.backendState, 'Unknown')
  assert.deepEqual(s.self, { hostName: null, tailscaleIPs: [] })
  assert.deepEqual(s.devices, [])
})
