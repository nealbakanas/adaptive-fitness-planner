// A stand-in heart-rate strap for tests: navigator.bluetooth with one device that sends Heart Rate Measurement values
// when the test says so. installFakeBluetooth() puts it on navigator; the returned object plays the strap.
export function installFakeBluetooth({ name = 'Powr Labs HR' } = {}) {
  const target = () => { const t = new EventTarget(); return t; };
  const chr = target();
  chr.value = null;
  chr.startNotifications = async () => { strap.notifying = true; return chr; };
  const dev = target();
  dev.name = name;
  dev.gatt = {
    connected: false,
    connect: async () => { if (strap.refuse) throw new Error('GATT connect failed'); dev.gatt.connected = true; strap.connects++; return dev.gatt; },
    disconnect: () => { dev.gatt.connected = false; },
    getPrimaryService: async () => ({ getCharacteristic: async () => chr }),
  };
  const strap = {
    connects: 0, notifying: false, refuse: false, picked: 0, cancel: false,
    // One reading: 8-bit, or 16-bit when it doesn't fit (as straps send them).
    beat(bpm) {
      const wide = bpm > 255, b = new DataView(new ArrayBuffer(wide ? 3 : 2));
      b.setUint8(0, wide ? 1 : 0);
      if (wide) b.setUint16(1, bpm, true); else b.setUint8(1, bpm);
      chr.value = b;
      chr.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    // The strap goes out of range.
    drop() { dev.gatt.connected = false; strap.notifying = false; dev.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  const bluetooth = {
    requestDevice: async opts => {
      strap.picked++;
      strap.lastFilters = opts?.filters;
      if (strap.cancel) { const e = new Error('User cancelled the requestDevice() chooser.'); e.name = 'NotFoundError'; throw e; }
      return dev;
    },
    getDevices: async () => (strap.picked ? [dev] : []),
  };
  Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true });
  return strap;
}
