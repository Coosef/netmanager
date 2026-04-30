// Common OUI vendor prefix lookup (first 3 octets of MAC address)
const OUI_MAP: Record<string, string> = {
  '00:00:0c': 'Cisco', '00:1a:a1': 'Cisco', '00:1b:54': 'Cisco', '00:1c:57': 'Cisco',
  '00:1d:45': 'Cisco', '00:1e:13': 'Cisco', '00:1e:49': 'Cisco', '00:1f:9e': 'Cisco',
  '00:21:1b': 'Cisco', '00:22:55': 'Cisco', '00:23:33': 'Cisco', '00:24:13': 'Cisco',
  '00:25:83': 'Cisco', '00:26:cb': 'Cisco', '00:27:0d': 'Cisco', '00:2a:6a': 'Cisco',
  '00:50:56': 'VMware', '00:0c:29': 'VMware', '00:05:69': 'VMware',
  '00:50:ba': 'D-Link', '00:1b:11': 'D-Link', '00:21:91': 'D-Link', '14:91:82': 'D-Link',
  '00:09:5b': 'Netgear', '00:14:6c': 'Netgear', '00:18:4d': 'Netgear', '00:24:b2': 'Netgear',
  '00:90:4c': 'Epigram', '00:03:52': 'Xircom', '00:04:5a': '3Com',
  '00:00:86': 'Megahertz', '00:01:42': 'Cisco', '00:60:47': 'Cisco',
  '38:ed:18': 'Cisco', '58:97:bd': 'Cisco', 'fc:5b:39': 'Cisco', 'e4:c7:22': 'Cisco',
  '00:30:48': 'Supermicro', 'ac:1f:6b': 'HP', '00:1a:4b': 'HP', '00:21:5a': 'HP',
  '3c:d9:2b': 'HP', '9c:8e:99': 'HP', 'b0:5a:da': 'HP', 'ec:b1:d7': 'HP',
  '00:26:55': 'HP', '00:17:a4': 'HP', '00:1e:0b': 'HP', '00:1f:29': 'HP',
  '00:19:bb': 'Aruba', '24:de:c6': 'Aruba', '6c:f3:7f': 'Aruba', '94:b4:0f': 'Aruba',
  'ac:a3:1e': 'Aruba', 'd8:c7:c8': 'Aruba', 'f0:5c:19': 'Aruba',
  '00:90:7f': 'WatchGuard', '00:1e:c9': 'Dell', '18:a9:9b': 'Dell', '14:18:77': 'Dell',
  '78:2b:cb': 'Dell', 'f4:8e:38': 'Dell', '00:25:64': 'Apple', '00:26:bb': 'Apple',
  '3c:15:c2': 'Apple', '28:37:37': 'Apple', 'ac:bc:32': 'Apple', 'f4:f1:5a': 'Apple',
  '00:1c:b3': 'Apple', '00:1d:4f': 'Apple', '00:23:6c': 'Apple', '00:25:4b': 'Apple',
  '00:26:08': 'Apple', '00:50:f2': 'Microsoft', '00:03:ff': 'Microsoft',
  '28:18:78': 'Microsoft', '58:82:a8': 'Microsoft',
  '00:16:3e': 'Xen', '52:54:00': 'QEMU/KVM', '00:15:5d': 'Hyper-V',
  '00:1b:21': 'Intel', '00:22:fb': 'Intel', '00:23:14': 'Intel', '00:27:10': 'Intel',
  'a0:36:9f': 'Intel', 'e0:69:95': 'Intel', '8c:ec:4b': 'Intel',
  '00:0d:ed': 'Brocade', '00:e0:52': 'Brocade', '00:05:1e': 'Brocade',
  '00:22:9e': 'Juniper', '2c:21:72': 'Juniper', '40:b4:f0': 'Juniper',
  '00:24:f9': 'Asus', '10:bf:48': 'Asus', '2c:fd:a1': 'Asus', '74:d0:2b': 'Asus',
  '1c:87:2c': 'TP-Link', '50:c7:bf': 'TP-Link', '64:70:02': 'TP-Link', 'ac:84:c6': 'TP-Link',
  '00:0a:e4': 'Ruijie', '00:d0:f8': 'Ruijie', '58:69:6c': 'Ruijie', 'cc:e4:03': 'Ruijie',
  '6c:2b:59': 'Ruijie', 'a0:ac:1a': 'Ruijie', '00:1a:2f': 'Ruijie',
  '00:26:b9': 'Samsung', '78:40:e4': 'Samsung', 'cc:07:ab': 'Samsung',
  '00:08:22': 'InPro', '00:1d:7e': 'Cisco Linksys', '00:14:bf': 'Cisco Linksys',
}

const VENDOR_COLORS: Record<string, string> = {
  'Cisco': '#1d6fa4', 'Aruba': '#ff8300', 'HP': '#0096d6', 'Ruijie': '#e4002b',
  'D-Link': '#0059a3', 'Netgear': '#004b87', 'Juniper': '#84b135', 'Brocade': '#d2232a',
  'Dell': '#007db8', 'Apple': '#555555', 'VMware': '#607078', 'Intel': '#0071c5',
  'TP-Link': '#4caf50', 'Samsung': '#1428a0', 'Microsoft': '#00a4ef',
}

export function ouiLookup(mac: string): string | null {
  if (!mac) return null
  // Normalize: lowercase, replace - with :
  const normalized = mac.toLowerCase().replace(/-/g, ':')
  const prefix = normalized.slice(0, 8) // e.g. "aa:bb:cc"
  return OUI_MAP[prefix] ?? null
}

export function ouiColor(vendor: string | null): string {
  if (!vendor) return '#94a3b8'
  return VENDOR_COLORS[vendor] ?? '#6b7280'
}
