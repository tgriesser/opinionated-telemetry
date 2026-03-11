type HrTime = [number, number]

export function hrTimeToMs(hr: HrTime): number {
  return hr[0] * 1e3 + hr[1] / 1e6
}

export function arrayStats(arr: number[]): {
  min: number
  max: number
  sum: number
} {
  let min = arr[0]
  let max = arr[0]
  let sum = arr[0]
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i]
    if (v < min) min = v
    else if (v > max) max = v
    sum += v
  }
  return { min, max, sum }
}
