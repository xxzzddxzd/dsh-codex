/** English copy for the device-local VLESS settings page. */
export const vlessEn = {
  nav: 'VLESS',
  title: 'VLESS',
  intro: 'Configure the device-local VLESS Reality exit. Providers choose whether to use it from their own settings pages.',
  node: 'VLESS Reality node',
  nodeHint: 'Paste a VLESS Reality link to replace the private local node. The link and credentials are never returned to the browser.',
  configured: 'Configured: {node}',
  notConfigured: 'No VLESS node configured',
  unnamedNode: 'VLESS Reality node',
  ready: 'client ready',
  unavailable: 'client unavailable',
  pid: 'PID {pid}',
  latency: 'Provider route warm {milliseconds} ms',
  speedTest: 'Speed test',
  speedTesting: 'Testing…',
  speedTestFailed: 'VLESS speed test failed.',
  linkPlaceholder: 'Paste a vless:// Reality link',
  save: 'Save and test',
  working: 'Working…',
  saved: 'Node saved and connectivity tested. Provider exit selections were not changed.',
  settingsFailed: 'VLESS settings could not be saved.',
}

/** Keys shared by both VLESS dictionaries. */
export type VlessSettingsKey = keyof typeof vlessEn

/** Chinese copy for the device-local VLESS settings page. */
export const vlessZh: { [Key in VlessSettingsKey]: string } = {
  nav: 'VLESS',
  title: 'VLESS',
  intro: '配置设备本地的 VLESS Reality 出口；各模型提供方可在自己的设置页选择是否使用。',
  node: 'VLESS Reality 节点',
  nodeHint: '粘贴 VLESS Reality 链接即可替换本地私有节点；网页不会读取或回显链接及节点凭据。',
  configured: '已配置：{node}',
  notConfigured: '尚未配置 VLESS 节点',
  unnamedNode: 'VLESS Reality 节点',
  ready: '客户端就绪',
  unavailable: '客户端不可用',
  pid: '进程号 {pid}',
  latency: 'Provider 路径热连接 {milliseconds} ms',
  speedTest: '测速',
  speedTesting: '测速中…',
  speedTestFailed: 'VLESS 测速失败。',
  linkPlaceholder: '粘贴 vless:// Reality 链接',
  save: '保存并测试',
  working: '处理中…',
  saved: '节点已保存并通过连通测试；各提供方的出口选择保持不变。',
  settingsFailed: '无法保存 VLESS 设置。',
}
