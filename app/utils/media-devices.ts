export type MediaDeviceOptionSource = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>

export function mediaDeviceItems(devices: readonly MediaDeviceOptionSource[], kind: MediaDeviceKind) {
  const fallbackLabel = kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker'

  return devices
    .filter(device => device.kind === kind && device.deviceId)
    .map((device, index) => ({
      label: device.label || `${fallbackLabel} ${index + 1}`,
      value: device.deviceId,
    }))
}
