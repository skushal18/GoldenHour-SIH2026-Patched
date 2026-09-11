(function() {
  "use strict";
  var _documentCurrentScript = typeof document !== "undefined" ? document.currentScript : null;
  const scriptRel = "modulepreload";
  const assetsURL = function(dep, importerUrl) {
    return new URL(dep, importerUrl).href;
  };
  const seen = {};
  const __vitePreload = function preload(baseModule, deps, importerUrl) {
    let promise = Promise.resolve();
    if (false) {
      const links = document.getElementsByTagName("link");
      const cspNonceMeta = document.querySelector(
        "meta[property=csp-nonce]"
      );
      const cspNonce = (cspNonceMeta == null ? void 0 : cspNonceMeta.nonce) || (cspNonceMeta == null ? void 0 : cspNonceMeta.getAttribute("nonce"));
      promise = Promise.allSettled(
        deps.map((dep) => {
          dep = assetsURL(dep, importerUrl);
          if (dep in seen) return;
          seen[dep] = true;
          const isCss = dep.endsWith(".css");
          const cssSelector = isCss ? '[rel="stylesheet"]' : "";
          const isBaseRelative = !!importerUrl;
          if (isBaseRelative) {
            for (let i = links.length - 1; i >= 0; i--) {
              const link2 = links[i];
              if (link2.href === dep && (!isCss || link2.rel === "stylesheet")) {
                return;
              }
            }
          } else if (document.querySelector(`link[href="${dep}"]${cssSelector}`)) {
            return;
          }
          const link = document.createElement("link");
          link.rel = isCss ? "stylesheet" : scriptRel;
          if (!isCss) {
            link.as = "script";
          }
          link.crossOrigin = "";
          link.href = dep;
          if (cspNonce) {
            link.setAttribute("nonce", cspNonce);
          }
          document.head.appendChild(link);
          if (isCss) {
            return new Promise((res, rej) => {
              link.addEventListener("load", res);
              link.addEventListener(
                "error",
                () => rej(new Error(`Unable to preload CSS for ${dep}`))
              );
            });
          }
        })
      );
    }
    function handlePreloadError(err) {
      const e = new Event("vite:preloadError", {
        cancelable: true
      });
      e.payload = err;
      window.dispatchEvent(e);
      if (!e.defaultPrevented) {
        throw err;
      }
    }
    return promise.then((res) => {
      for (const item of res || []) {
        if (item.status !== "rejected") continue;
        handlePreloadError(item.reason);
      }
      return baseModule().catch(handlePreloadError);
    });
  };
  /*! Capacitor: https://capacitorjs.com/ - MIT License */
  var ExceptionCode;
  (function(ExceptionCode2) {
    ExceptionCode2["Unimplemented"] = "UNIMPLEMENTED";
    ExceptionCode2["Unavailable"] = "UNAVAILABLE";
  })(ExceptionCode || (ExceptionCode = {}));
  class CapacitorException extends Error {
    constructor(message, code, data) {
      super(message);
      this.message = message;
      this.code = code;
      this.data = data;
    }
  }
  const getPlatformId = (win) => {
    var _a, _b;
    if (win === null || win === void 0 ? void 0 : win.androidBridge) {
      return "android";
    } else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) {
      return "ios";
    } else {
      return "web";
    }
  };
  const createCapacitor = (win) => {
    const capCustomPlatform = win.CapacitorCustomPlatform || null;
    const cap = win.Capacitor || {};
    const Plugins = cap.Plugins = cap.Plugins || {};
    const getPlatform = () => {
      return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
    };
    const isNativePlatform = () => getPlatform() !== "web";
    const isPluginAvailable = (pluginName) => {
      const plugin = registeredPlugins.get(pluginName);
      if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) {
        return true;
      }
      if (getPluginHeader(pluginName)) {
        return true;
      }
      return false;
    };
    const getPluginHeader = (pluginName) => {
      var _a;
      return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
    };
    const handleError = (err) => win.console.error(err);
    const registeredPlugins = /* @__PURE__ */ new Map();
    const registerPlugin2 = (pluginName, jsImplementations = {}) => {
      const registeredPlugin = registeredPlugins.get(pluginName);
      if (registeredPlugin) {
        console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
        return registeredPlugin.proxy;
      }
      const platform = getPlatform();
      const pluginHeader = getPluginHeader(pluginName);
      let jsImplementation;
      const loadPluginImplementation = async () => {
        if (!jsImplementation && platform in jsImplementations) {
          jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
        } else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) {
          jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
        }
        return jsImplementation;
      };
      const createPluginMethod = (impl, prop) => {
        var _a, _b;
        if (pluginHeader) {
          const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
          if (methodHeader) {
            if (methodHeader.rtype === "promise") {
              return (options) => cap.nativePromise(pluginName, prop.toString(), options);
            } else {
              return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
            }
          } else if (impl) {
            return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
          }
        } else if (impl) {
          return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
        } else {
          throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, ExceptionCode.Unimplemented);
        }
      };
      const createPluginMethodWrapper = (prop) => {
        let remove;
        const wrapper = (...args) => {
          const p = loadPluginImplementation().then((impl) => {
            const fn = createPluginMethod(impl, prop);
            if (fn) {
              const p2 = fn(...args);
              remove = p2 === null || p2 === void 0 ? void 0 : p2.remove;
              return p2;
            } else {
              throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, ExceptionCode.Unimplemented);
            }
          });
          if (prop === "addListener") {
            p.remove = async () => remove();
          }
          return p;
        };
        wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
        Object.defineProperty(wrapper, "name", {
          value: prop,
          writable: false,
          configurable: false
        });
        return wrapper;
      };
      const addListener = createPluginMethodWrapper("addListener");
      const removeListener = createPluginMethodWrapper("removeListener");
      const addListenerNative = (eventName, callback) => {
        const call = addListener({ eventName }, callback);
        const remove = async () => {
          const callbackId = await call;
          removeListener({
            eventName,
            callbackId
          }, callback);
        };
        const p = new Promise((resolve) => call.then(() => resolve({ remove })));
        p.remove = async () => {
          console.warn(`Using addListener() without 'await' is deprecated.`);
          await remove();
        };
        return p;
      };
      const proxy = new Proxy({}, {
        get(_, prop) {
          switch (prop) {
            case "$$typeof":
              return void 0;
            case "toJSON":
              return () => ({});
            case "addListener":
              return pluginHeader ? addListenerNative : addListener;
            case "removeListener":
              return removeListener;
            default:
              return createPluginMethodWrapper(prop);
          }
        }
      });
      Plugins[pluginName] = proxy;
      registeredPlugins.set(pluginName, {
        name: pluginName,
        proxy,
        platforms: /* @__PURE__ */ new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
      });
      return proxy;
    };
    if (!cap.convertFileSrc) {
      cap.convertFileSrc = (filePath) => filePath;
    }
    cap.getPlatform = getPlatform;
    cap.handleError = handleError;
    cap.isNativePlatform = isNativePlatform;
    cap.isPluginAvailable = isPluginAvailable;
    cap.registerPlugin = registerPlugin2;
    cap.Exception = CapacitorException;
    cap.DEBUG = !!cap.DEBUG;
    cap.isLoggingEnabled = !!cap.isLoggingEnabled;
    return cap;
  };
  const initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
  const Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
  const registerPlugin = Capacitor.registerPlugin;
  class WebPlugin {
    constructor() {
      this.listeners = {};
      this.retainedEventArguments = {};
      this.windowListeners = {};
    }
    addListener(eventName, listenerFunc) {
      let firstListener = false;
      const listeners = this.listeners[eventName];
      if (!listeners) {
        this.listeners[eventName] = [];
        firstListener = true;
      }
      this.listeners[eventName].push(listenerFunc);
      const windowListener = this.windowListeners[eventName];
      if (windowListener && !windowListener.registered) {
        this.addWindowListener(windowListener);
      }
      if (firstListener) {
        this.sendRetainedArgumentsForEvent(eventName);
      }
      const remove = async () => this.removeListener(eventName, listenerFunc);
      const p = Promise.resolve({ remove });
      return p;
    }
    async removeAllListeners() {
      this.listeners = {};
      for (const listener in this.windowListeners) {
        this.removeWindowListener(this.windowListeners[listener]);
      }
      this.windowListeners = {};
    }
    notifyListeners(eventName, data, retainUntilConsumed) {
      const listeners = this.listeners[eventName];
      if (!listeners) {
        if (retainUntilConsumed) {
          let args = this.retainedEventArguments[eventName];
          if (!args) {
            args = [];
          }
          args.push(data);
          this.retainedEventArguments[eventName] = args;
        }
        return;
      }
      listeners.forEach((listener) => listener(data));
    }
    hasListeners(eventName) {
      var _a;
      return !!((_a = this.listeners[eventName]) === null || _a === void 0 ? void 0 : _a.length);
    }
    registerWindowListener(windowEventName, pluginEventName) {
      this.windowListeners[pluginEventName] = {
        registered: false,
        windowEventName,
        pluginEventName,
        handler: (event) => {
          this.notifyListeners(pluginEventName, event);
        }
      };
    }
    unimplemented(msg = "not implemented") {
      return new Capacitor.Exception(msg, ExceptionCode.Unimplemented);
    }
    unavailable(msg = "not available") {
      return new Capacitor.Exception(msg, ExceptionCode.Unavailable);
    }
    async removeListener(eventName, listenerFunc) {
      const listeners = this.listeners[eventName];
      if (!listeners) {
        return;
      }
      const index = listeners.indexOf(listenerFunc);
      if (index !== -1) {
        this.listeners[eventName].splice(index, 1);
      }
      if (!this.listeners[eventName].length) {
        this.removeWindowListener(this.windowListeners[eventName]);
      }
    }
    addWindowListener(handle) {
      window.addEventListener(handle.windowEventName, handle.handler);
      handle.registered = true;
    }
    removeWindowListener(handle) {
      if (!handle) {
        return;
      }
      window.removeEventListener(handle.windowEventName, handle.handler);
      handle.registered = false;
    }
    sendRetainedArgumentsForEvent(eventName) {
      const args = this.retainedEventArguments[eventName];
      if (!args) {
        return;
      }
      delete this.retainedEventArguments[eventName];
      args.forEach((arg) => {
        this.notifyListeners(eventName, arg);
      });
    }
  }
  const encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
  const decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
  class CapacitorCookiesPluginWeb extends WebPlugin {
    async getCookies() {
      const cookies = document.cookie;
      const cookieMap = {};
      cookies.split(";").forEach((cookie) => {
        if (cookie.length <= 0)
          return;
        let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
        key = decode(key).trim();
        value = decode(value).trim();
        cookieMap[key] = value;
      });
      return cookieMap;
    }
    async setCookie(options) {
      try {
        const encodedKey = encode(options.key);
        const encodedValue = encode(options.value);
        const expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "";
        const path = (options.path || "/").replace("path=", "");
        const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
        document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    async deleteCookie(options) {
      try {
        document.cookie = `${options.key}=; Max-Age=0`;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    async clearCookies() {
      try {
        const cookies = document.cookie.split(";") || [];
        for (const cookie of cookies) {
          document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
        }
      } catch (error) {
        return Promise.reject(error);
      }
    }
    async clearAllCookies() {
      try {
        await this.clearCookies();
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }
  registerPlugin("CapacitorCookies", {
    web: () => new CapacitorCookiesPluginWeb()
  });
  const readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result;
      resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(blob);
  });
  const normalizeHttpHeaders = (headers = {}) => {
    const originalKeys = Object.keys(headers);
    const loweredKeys = Object.keys(headers).map((k) => k.toLocaleLowerCase());
    const normalized = loweredKeys.reduce((acc, key, index) => {
      acc[key] = headers[originalKeys[index]];
      return acc;
    }, {});
    return normalized;
  };
  const buildUrlParams = (params, shouldEncode = true) => {
    if (!params)
      return null;
    const output = Object.entries(params).reduce((accumulator, entry) => {
      const [key, value] = entry;
      let encodedValue;
      let item;
      if (Array.isArray(value)) {
        item = "";
        value.forEach((str) => {
          encodedValue = shouldEncode ? encodeURIComponent(str) : str;
          item += `${key}=${encodedValue}&`;
        });
        item.slice(0, -1);
      } else {
        encodedValue = shouldEncode ? encodeURIComponent(value) : value;
        item = `${key}=${encodedValue}`;
      }
      return `${accumulator}&${item}`;
    }, "");
    return output.substr(1);
  };
  const buildRequestInit = (options, extra = {}) => {
    const output = Object.assign({ method: options.method || "GET", headers: options.headers }, extra);
    const headers = normalizeHttpHeaders(options.headers);
    const type = headers["content-type"] || "";
    if (typeof options.data === "string") {
      output.body = options.data;
    } else if (type.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.data || {})) {
        params.set(key, value);
      }
      output.body = params.toString();
    } else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
      const form = new FormData();
      if (options.data instanceof FormData) {
        options.data.forEach((value, key) => {
          form.append(key, value);
        });
      } else {
        for (const key of Object.keys(options.data)) {
          form.append(key, options.data[key]);
        }
      }
      output.body = form;
      const headers2 = new Headers(output.headers);
      headers2.delete("content-type");
      output.headers = headers2;
    } else if (type.includes("application/json") || typeof options.data === "object") {
      output.body = JSON.stringify(options.data);
    }
    return output;
  };
  class CapacitorHttpPluginWeb extends WebPlugin {
    /**
     * Perform an Http request given a set of options
     * @param options Options to build the HTTP request
     */
    async request(options) {
      const requestInit = buildRequestInit(options, options.webFetchExtra);
      const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
      const url = urlParams ? `${options.url}?${urlParams}` : options.url;
      const response = await fetch(url, requestInit);
      const contentType = response.headers.get("content-type") || "";
      let { responseType = "text" } = response.ok ? options : {};
      if (contentType.includes("application/json")) {
        responseType = "json";
      }
      let data;
      let blob;
      switch (responseType) {
        case "arraybuffer":
        case "blob":
          blob = await response.blob();
          data = await readBlobAsBase64(blob);
          break;
        case "json":
          data = await response.json();
          break;
        case "document":
        case "text":
        default:
          data = await response.text();
      }
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        data,
        headers,
        status: response.status,
        url: response.url
      };
    }
    /**
     * Perform an Http GET request given a set of options
     * @param options Options to build the HTTP request
     */
    async get(options) {
      return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
    }
    /**
     * Perform an Http POST request given a set of options
     * @param options Options to build the HTTP request
     */
    async post(options) {
      return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
    }
    /**
     * Perform an Http PUT request given a set of options
     * @param options Options to build the HTTP request
     */
    async put(options) {
      return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
    }
    /**
     * Perform an Http PATCH request given a set of options
     * @param options Options to build the HTTP request
     */
    async patch(options) {
      return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
    }
    /**
     * Perform an Http DELETE request given a set of options
     * @param options Options to build the HTTP request
     */
    async delete(options) {
      return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
    }
  }
  registerPlugin("CapacitorHttp", {
    web: () => new CapacitorHttpPluginWeb()
  });
  var SystemBarsStyle;
  (function(SystemBarsStyle2) {
    SystemBarsStyle2["Dark"] = "DARK";
    SystemBarsStyle2["Light"] = "LIGHT";
    SystemBarsStyle2["Default"] = "DEFAULT";
  })(SystemBarsStyle || (SystemBarsStyle = {}));
  var SystemBarType;
  (function(SystemBarType2) {
    SystemBarType2["StatusBar"] = "StatusBar";
    SystemBarType2["NavigationBar"] = "NavigationBar";
  })(SystemBarType || (SystemBarType = {}));
  class SystemBarsPluginWeb extends WebPlugin {
    async setStyle() {
      this.unavailable("not available for web");
    }
    async setAnimation() {
      this.unavailable("not available for web");
    }
    async show() {
      this.unavailable("not available for web");
    }
    async hide() {
      this.unavailable("not available for web");
    }
  }
  registerPlugin("SystemBars", {
    web: () => new SystemBarsPluginWeb()
  });
  function s(t) {
    t.CapacitorUtils.Synapse = new Proxy(
      {},
      {
        get(e, n) {
          return new Proxy({}, {
            get(w, o) {
              return (c, p, r) => {
                const i = t.Capacitor.Plugins[n];
                if (i === void 0) {
                  r(new Error(`Capacitor plugin ${n} not found`));
                  return;
                }
                if (typeof i[o] != "function") {
                  r(new Error(`Method ${o} not found in Capacitor plugin ${n}`));
                  return;
                }
                (async () => {
                  try {
                    const a = await i[o](c);
                    p(a);
                  } catch (a) {
                    r(a);
                  }
                })();
              };
            }
          });
        }
      }
    );
  }
  function u(t) {
    t.CapacitorUtils.Synapse = new Proxy(
      {},
      {
        get(e, n) {
          return t.cordova.plugins[n];
        }
      }
    );
  }
  function f(t = false) {
    typeof window > "u" || (window.CapacitorUtils = window.CapacitorUtils || {}, window.Capacitor !== void 0 && !t ? s(window) : window.cordova !== void 0 && u(window));
  }
  const Geolocation$1 = registerPlugin("Geolocation", {
    web: () => __vitePreload(() => Promise.resolve().then(() => web), false ? __VITE_PRELOAD__ : void 0, _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT" && _documentCurrentScript.src || new URL("app.js", document.baseURI).href).then((m) => new m.GeolocationWeb())
  });
  f();
  function watchPosition({ native, plugin, geolocation, onPosition, onError }) {
    let cancelled = false, id = null;
    const options = { enableHighAccuracy: true, maximumAge: 5e3, timeout: 2e4, minimumUpdateInterval: 1e4, interval: 1e4 };
    const clear = () => {
      if (id === null) return;
      if (native) Promise.resolve(plugin.clearWatch({ id })).catch(() => {
      });
      else geolocation.clearWatch(id);
      id = null;
    };
    const success = (pos) => {
      if (!cancelled) onPosition(pos);
    };
    const failure = (err) => {
      if (!cancelled) onError(err);
    };
    if (native) {
      Promise.resolve().then(async () => {
        const permission = await plugin.requestPermissions({ permissions: ["location"] });
        if (cancelled) return;
        if (permission.location !== "granted") throw new Error("Allow precise location permission to share GPS.");
        id = await plugin.watchPosition(options, (pos, err) => err ? failure(err) : pos && success(pos));
        if (cancelled) clear();
      }).catch(failure);
    } else {
      try {
        if (!geolocation || !geolocation.watchPosition) throw new Error("Location service is unavailable.");
        id = geolocation.watchPosition(success, failure, options);
      } catch (err) {
        failure(err);
      }
    }
    return () => {
      cancelled = true;
      clear();
    };
  }
  async function recordArrival({ socket, fetch: fetcher, apiRoot, caseCode, timeoutMs = 5e3 }) {
    if (socket && socket.connected) {
      const ack = await new Promise((resolve) => {
        const timer2 = setTimeout(() => resolve(null), timeoutMs);
        socket.emit("ambulance:arrived", { case_code: caseCode }, (body) => {
          clearTimeout(timer2);
          resolve(body);
        });
      });
      if (ack && ack.success === true) return ack;
      if (ack && ack.success === false) throw new Error(ack.message || "Arrival was refused");
    }
    if (!apiRoot || typeof fetcher !== "function") throw new Error("No connection to the server");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(apiRoot + "/requests/" + encodeURIComponent(caseCode) + "/arrived", { method: "POST", signal: controller.signal });
      const body = await response.json();
      if (!response.ok || !body || body.success !== true || body.status !== "ARRIVED") throw new Error(body && body.message || "Arrival was refused");
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
  const AGE_BANDS = [
    { id: "baby", label: "Baby", hint: "0 – 3", value: 1, min: 0, max: 3 },
    { id: "child", label: "Child", hint: "3 – 17", value: 8, min: 3, max: 18 },
    { id: "adult", label: "Adult", hint: "18 – 60", value: 35, min: 18, max: 60 },
    { id: "senior", label: "Senior citizen", hint: "60+", value: 75, min: 60, max: 131 },
    { id: "unknown", label: "Unknown", hint: "Not known", value: null, min: null, max: null }
  ];
  const UNKNOWN = AGE_BANDS[AGE_BANDS.length - 1];
  function ageBandById(id) {
    return AGE_BANDS.find((b) => b.id === id) || null;
  }
  function describeAgeBand(age) {
    if (age === null || age === void 0 || !["number", "string"].includes(typeof age) || String(age).trim() === "") return UNKNOWN;
    const n = Number(age);
    if (!Number.isFinite(n) || n < 0 || n > 130) return UNKNOWN;
    return AGE_BANDS.find((b) => b.min !== null && n >= b.min && n < b.max) || UNKNOWN;
  }
  function ageBandLabel(age) {
    return describeAgeBand(age).label;
  }
  const MAX_IMAGES = 4;
  function toNumberOrNull(value) {
    if (value === null || value === void 0) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function toTextOrNull(value) {
    if (value === null || value === void 0) return null;
    const s2 = String(value).trim();
    return s2 === "" ? null : s2;
  }
  const VITALS = {
    systolicBp: { range: [40, 300], bands: [[90, "critical"], [100, "caution"], [140, "good"], [180, "caution"], [Infinity, "critical"]] },
    diastolicBp: { range: [20, 200], bands: [[50, "critical"], [60, "caution"], [90, "good"], [120, "caution"], [Infinity, "critical"]] },
    heartRate: { range: [20, 300], bands: [[50, "critical"], [60, "caution"], [101, "good"], [121, "caution"], [Infinity, "critical"]] },
    respRate: { range: [4, 80], bands: [[9, "critical"], [12, "caution"], [21, "good"], [30, "caution"], [Infinity, "critical"]] },
    spo2: { range: [50, 100], bands: [[90, "critical"], [95, "caution"], [Infinity, "good"]] },
    glucose: { range: [10, 900], bands: [[60, "critical"], [70, "caution"], [141, "good"], [250, "caution"], [Infinity, "critical"]] }
  };
  const VITAL_KEYS = Object.keys(VITALS);
  function getBandFor(key, value) {
    const spec = VITALS[key];
    if (!spec) return null;
    const n = toNumberOrNull(value);
    if (n === null) return null;
    if (n < spec.range[0] || n > spec.range[1]) return null;
    for (const [ceiling, band] of spec.bands) if (n < ceiling) return band;
    return null;
  }
  function isOutOfRange(key, value) {
    const spec = VITALS[key];
    if (!spec) return false;
    const n = toNumberOrNull(value);
    if (n === null) return false;
    return n < spec.range[0] || n > spec.range[1];
  }
  function deriveNeeds(form) {
    const f2 = form || {};
    const v = f2.vitals || {};
    const needs = { ventilator: false, blood: false, imaging: false, ot: false, cathlab: false };
    const spo2 = toNumberOrNull(v.spo2);
    const sbp = toNumberOrNull(v.systolic_bp);
    if (f2.consciousness === "Unconscious") needs.ventilator = true;
    if (spo2 !== null && spo2 < 90) needs.ventilator = true;
    if (sbp !== null && sbp < 90) needs.blood = true;
    switch (f2.category) {
      case "TRAUMA":
      case "OBSTETRIC":
        needs.blood = true;
        needs.imaging = true;
        needs.ot = true;
        break;
      case "STROKE":
      case "NEURO":
        needs.imaging = true;
        break;
      case "CARDIAC":
        needs.imaging = true;
        needs.cathlab = true;
        break;
    }
    return needs;
  }
  function buildPayload(form) {
    const f2 = form || {};
    const source = toTextOrNull(f2.originSource);
    const isMeasured = source === "gps" || source === "last-known";
    const payload = {
      case_type_id: toNumberOrNull(f2.caseTypeId),
      age: toNumberOrNull(f2.age),
      gender: toTextOrNull(f2.gender) || "U",
      blood_group: toTextOrNull(f2.bloodGroup),
      vitals: {
        systolic_bp: toNumberOrNull(f2.systolicBp),
        diastolic_bp: toNumberOrNull(f2.diastolicBp),
        heart_rate: toNumberOrNull(f2.heartRate),
        resp_rate: toNumberOrNull(f2.respRate),
        spo2: toNumberOrNull(f2.spo2),
        glucose: toNumberOrNull(f2.glucose)
      },
      consciousness: toTextOrNull(f2.consciousness),
      origin: {
        lat: toNumberOrNull(f2.lat),
        lng: toNumberOrNull(f2.lng),
        accuracy_m: isMeasured ? toNumberOrNull(f2.accuracy) : null,
        source
      },
      broadcast_radius_km: toNumberOrNull(f2.radiusKm) === null ? 15 : toNumberOrNull(f2.radiusKm),
      images: Array.isArray(f2.images) ? f2.images.slice(0, MAX_IMAGES) : [],
      eta_minutes: toNumberOrNull(f2.eta),
      notes: toTextOrNull(f2.notes),
      ambulance_id: toTextOrNull(f2.ambulanceId)
    };
    if (f2.category === "STROKE") {
      payload.stroke_assessment = {
        face: !!f2.face,
        arm: !!f2.arm,
        speech: !!f2.speech,
        onset_hours: toNumberOrNull(f2.onsetHours)
      };
    }
    return payload;
  }
  const DEMO_CASE_TYPES = [
    { id: 1, category: "TRAUMA", label: "Road accident — multiple injuries", quick: true, short: "Road accident" },
    { id: 2, category: "TRAUMA", label: "Head injury", quick: true, short: "Head injury" },
    { id: 3, category: "TRAUMA", label: "Fall from height" },
    { id: 4, category: "TRAUMA", label: "Crush injury / amputation" },
    { id: 5, category: "TRAUMA", label: "Penetrating injury / stabbing" },
    { id: 6, category: "TRAUMA", label: "Major burns" },
    { id: 7, category: "TRAUMA", label: "Spinal injury suspected" },
    { id: 8, category: "CARDIAC", label: "Chest pain — suspected heart attack", quick: true, short: "Chest pain" },
    { id: 9, category: "CARDIAC", label: "Cardiac arrest", quick: true, short: "Cardiac arrest" },
    { id: 10, category: "CARDIAC", label: "Irregular heartbeat / palpitations" },
    { id: 11, category: "CARDIAC", label: "Heart failure / severe swelling" },
    { id: 12, category: "STROKE", label: "Stroke — sudden weakness or slurred speech", quick: true, short: "Stroke" },
    { id: 13, category: "STROKE", label: "Transient ischaemic attack" },
    { id: 14, category: "NEURO", label: "Seizure / fitting" },
    { id: 15, category: "NEURO", label: "Unresponsive — cause unknown" },
    { id: 16, category: "RESP", label: "Severe breathlessness", quick: true, short: "Breathless" },
    { id: 17, category: "RESP", label: "Asthma attack" },
    { id: 18, category: "RESP", label: "Choking / airway obstruction" },
    { id: 19, category: "RESP", label: "Drowning / near-drowning" },
    { id: 20, category: "OBSTETRIC", label: "Labour / imminent delivery" },
    { id: 21, category: "OBSTETRIC", label: "Pregnancy complication / bleeding" },
    { id: 22, category: "OBSTETRIC", label: "Eclampsia / seizure in pregnancy" },
    { id: 23, category: "PAEDIATRIC", label: "Child — serious illness" },
    { id: 24, category: "PAEDIATRIC", label: "Child — injury" },
    { id: 25, category: "PAEDIATRIC", label: "Newborn in distress" },
    { id: 26, category: "TOXIC", label: "Poisoning / overdose" },
    { id: 27, category: "TOXIC", label: "Snake or animal bite" },
    { id: 28, category: "TOXIC", label: "Severe allergic reaction" },
    { id: 29, category: "TOXIC", label: "Smoke or gas inhalation" },
    { id: 30, category: "MEDICAL", label: "Diabetic emergency" },
    { id: 31, category: "MEDICAL", label: "Heavy bleeding — non-trauma" },
    { id: 32, category: "MEDICAL", label: "Severe abdominal pain" },
    { id: 33, category: "MEDICAL", label: "Severe infection / sepsis suspected" }
  ];
  const CATEGORY_LABELS = [
    ["TRAUMA", "Trauma & injury"],
    ["CARDIAC", "Cardiac"],
    ["STROKE", "Stroke"],
    ["NEURO", "Neurological"],
    ["RESP", "Breathing & airway"],
    ["OBSTETRIC", "Pregnancy & birth"],
    ["PAEDIATRIC", "Children"],
    ["TOXIC", "Poisoning & bites"],
    ["MEDICAL", "Other medical"]
  ];
  function categoryOf(caseTypes, id) {
    const n = toNumberOrNull(id);
    if (n === null) return null;
    const t = (caseTypes || []).find((c) => Number(c.id) === n);
    return t ? t.category : null;
  }
  const PLACEHOLDER = /replace[-_ ]?with|your[-_ ]?backend|example\.com|changeme/i;
  const DEFAULT_CONFIG = {
    SERVER_BASE: "",
    API_PATH: "/api/v1",
    MODE: "auto",
    REALTIME: true,
    POLL_MS: 4e3,
    FALLBACK_ORIGIN: { lat: 12.9716, lng: 77.5946, label: "Bengaluru city centre" }
  };
  function usableServerBase(value) {
    if (value === null || value === void 0) return null;
    const s2 = String(value).trim().replace(/\/+$/, "");
    if (!s2) return null;
    if (PLACEHOLDER.test(s2)) return null;
    if (!/^https?:\/\//i.test(s2)) return null;
    return s2;
  }
  function isCapacitorRuntime(win) {
    try {
      const cap = win && win.Capacitor;
      if (!cap) return false;
      if (typeof cap.isNativePlatform === "function") return !!cap.isNativePlatform();
      return !!cap.isNative;
    } catch (_) {
      return false;
    }
  }
  function resolveEnvironment(options) {
    const opts = options || {};
    const cfg = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
    const loc = opts.location || {};
    const protocol = String(loc.protocol || "").toLowerCase();
    const origin = loc.origin && loc.origin !== "null" ? String(loc.origin).replace(/\/+$/, "") : null;
    const apiPath = cfg.API_PATH || "/api/v1";
    const base = usableServerBase(cfg.SERVER_BASE);
    const capacitor = !!opts.capacitor;
    let demo;
    let reason;
    if (typeof opts.forceDemo === "boolean") {
      demo = opts.forceDemo;
      reason = "forced by test harness";
    } else if (cfg.MODE === "demo") {
      demo = true;
      reason = "config MODE is demo";
    } else if (cfg.MODE === "live") {
      demo = false;
      reason = "config MODE is live";
    } else if (base) {
      demo = false;
      reason = "SERVER_BASE is configured";
    } else if (capacitor) {
      demo = true;
      reason = "running as an APK with no SERVER_BASE set";
    } else if (protocol === "file:") {
      demo = true;
      reason = "opened straight off disk — there is no server to talk to";
    } else if (protocol === "http:" || protocol === "https:") {
      demo = false;
      reason = "served over the network — using the page origin";
    } else {
      demo = true;
      reason = "no reachable backend could be determined";
    }
    const root = base || (demo ? null : origin);
    return {
      demo,
      reason,
      serverBase: base,
      apiRoot: root ? root + apiPath : null,
      realtime: cfg.REALTIME !== false,
      pollMs: Number(cfg.POLL_MS) > 0 ? Number(cfg.POLL_MS) : 4e3,
      fallbackOrigin: cfg.FALLBACK_ORIGIN || null,
      config: cfg
    };
  }
  const LAST_FIX_KEY = "gh_last_fix";
  const LAST_FIX_MAX_AGE_MS = 20 * 60 * 1e3;
  const SOURCE_LABELS = {
    "gps": "GPS",
    "last-known": "recalled fix",
    "manual": "set by hand",
    "demo": "demo position"
  };
  function validCoords(lat, lng) {
    const a = toNumberOrNull(lat);
    const b = toNumberOrNull(lng);
    if (a === null || b === null) return null;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < -90 || a > 90) return null;
    if (b < -180 || b > 180) return null;
    if (a === 0 && b === 0) return null;
    return { lat: a, lng: b };
  }
  function describeGeoError(err) {
    const code = err && err.code;
    const raw = String(err && err.message || "");
    if (/secure origin|secure context|only secure/i.test(raw)) {
      return "This page is on plain http, so the browser will not release GPS. Use the app build, or pick a starting point below.";
    }
    if (code === 1) {
      return "Location permission was refused. Pick a starting point below, or allow location and try again.";
    }
    if (code === 2) {
      return "The device could not get a fix. Pick a starting point below, or type the coordinates.";
    }
    if (code === 3) {
      return "Locating timed out. Pick a starting point below, or type the coordinates.";
    }
    return "Location is unavailable. Pick a starting point below, or type the coordinates.";
  }
  function noGeolocationMessage() {
    return "This device offers no location service. Pick a starting point below, or type the coordinates.";
  }
  function describeAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const mins = Math.floor(ms / 6e4);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    const hours = Math.floor(mins / 60);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
  }
  function readLastFix(storage, now) {
    try {
      const raw = storage.getItem(LAST_FIX_KEY);
      if (!raw) return null;
      const fix = JSON.parse(raw);
      const coords = validCoords(fix && fix.lat, fix && fix.lng);
      if (!coords) return null;
      const ts = Number(fix.ts);
      if (!Number.isFinite(ts)) return null;
      const age = (now || Date.now()) - ts;
      if (age < 0 || age > LAST_FIX_MAX_AGE_MS) return null;
      return { lat: coords.lat, lng: coords.lng, accuracy: toNumberOrNull(fix.accuracy), ts, age };
    } catch (_) {
      return null;
    }
  }
  function writeLastFix(storage, fix) {
    try {
      storage.setItem(LAST_FIX_KEY, JSON.stringify({
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy == null ? null : fix.accuracy,
        ts: Date.now()
      }));
      return true;
    } catch (_) {
      return false;
    }
  }
  const DEMO_HOSPITALS_NOTIFIED = 3;
  const DEMO_ACCEPTOR = {
    hospital_id: 1,
    name: "Demo City ER",
    distance_km: 3.4,
    phone: "+911234567890",
    lat: 12.9899,
    lng: 77.5921
  };
  class NetworkError extends Error {
    constructor(message) {
      super(message || "Network unreachable");
      this.name = "NetworkError";
      this.network = true;
    }
  }
  class RejectedError extends Error {
    constructor(message, status) {
      super(message || "Rejected");
      this.name = "RejectedError";
      this.status = status;
    }
  }
  function createLiveTransport(apiRoot, fetchImpl) {
    const doFetch = fetchImpl;
    const url = (path) => apiRoot.replace(/\/+$/, "") + path;
    async function readJson(res) {
      try {
        return await res.json();
      } catch (_) {
        return null;
      }
    }
    return {
      kind: "live",
      async caseTypes() {
        const res = await doFetch(url("/case-types"));
        if (!res.ok) throw new RejectedError("HTTP " + res.status, res.status);
        return await res.json();
      },
      async broadcast(payload, clientRequestId) {
        let res;
        try {
          res = await doFetch(url("/requests"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Client-Request-Id": clientRequestId },
            body: JSON.stringify(payload)
          });
        } catch (err) {
          throw new NetworkError(err && err.message);
        }
        if (res.status >= 500) throw new NetworkError("Server error " + res.status);
        const body = await readJson(res);
        if (!res.ok) throw new RejectedError(body && body.message || "HTTP " + res.status, res.status);
        return body;
      },
      async status(caseCode) {
        let res;
        try {
          res = await doFetch(url("/requests/" + encodeURIComponent(caseCode)));
        } catch (err) {
          throw new NetworkError(err && err.message);
        }
        if (!res.ok) throw new RejectedError("HTTP " + res.status, res.status);
        return await res.json();
      }
    };
  }
  function createDemoTransport(options) {
    const opts = options || {};
    const delay = () => Number(opts.postMs && opts.postMs()) || 300;
    const shouldFail = () => !!(opts.shouldFail && opts.shouldFail());
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let counter = 0;
    const cases = /* @__PURE__ */ new Map();
    return {
      kind: "demo",
      async caseTypes() {
        return opts.caseTypes || [];
      },
      async broadcast(payload) {
        await wait(delay());
        if (shouldFail()) throw new NetworkError("Demo mode: simulated send failure");
        counter += 1;
        const id = "GH-DEMO-" + String(counter).padStart(4, "0");
        const now = Date.now();
        cases.set(id, { id, created: now, payload });
        return {
          id,
          status: "PENDING",
          hospitals_notified: DEMO_HOSPITALS_NOTIFIED,
          expires_at: new Date(now + 18e4).toISOString(),
          priority: "RED"
        };
      },
      async status(caseCode) {
        const entry = cases.get(caseCode);
        if (!entry) throw new RejectedError("Unknown case", 404);
        const accepted = Date.now() - entry.created >= Math.max(20, delay() * 4);
        if (!accepted) {
          return { id: caseCode, status: "PENDING", hospitals_notified: DEMO_HOSPITALS_NOTIFIED, priority: "RED" };
        }
        return {
          id: caseCode,
          status: "ACCEPTED",
          priority: "RED",
          hospitals_notified: DEMO_HOSPITALS_NOTIFIED,
          accepted_by: DEMO_ACCEPTOR.name,
          accepted_hospital: Object.assign({}, DEMO_ACCEPTOR)
        };
      }
    };
  }
  const OUTBOX_KEY = "goldenhour.outbox";
  const MAX_QUEUED = 3;
  const STALE_MS = 15 * 60 * 1e3;
  function createOutbox(storage, options) {
    const opts = options || {};
    let entries = read();
    function read() {
      try {
        const raw = storage.getItem(OUTBOX_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(0, MAX_QUEUED) : [];
      } catch (_) {
        return [];
      }
    }
    function persist() {
      try {
        storage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, MAX_QUEUED)));
        return true;
      } catch (err) {
        const stripped = entries.slice().reverse().find((e) => e.payload && e.payload.images && e.payload.images.length);
        if (stripped) {
          stripped.payload.images = [];
          stripped.photos_dropped = true;
          try {
            storage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, MAX_QUEUED)));
            return true;
          } catch (_) {
          }
        }
        return false;
      }
    }
    return {
      all() {
        return entries.slice();
      },
      count() {
        return entries.length;
      },
      isEmpty() {
        return entries.length === 0;
      },
      /** @returns true if the case is safely queued, false if it could not be. */
      enqueue(payload) {
        const entry = {
          id: "ob-" + Date.now() + "-" + Math.floor(Math.random() * 1e6).toString(36),
          payload,
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          attempts: 0,
          last_error: null,
          last_attempt_at: null
        };
        entries.unshift(entry);
        entries = entries.slice(0, MAX_QUEUED);
        return persist() ? entry : (entries = entries.filter((e) => e !== entry), false);
      },
      remove(id) {
        entries = entries.filter((e) => e.id !== id);
        persist();
      },
      clear() {
        entries = [];
        persist();
      },
      stale(now) {
        const cutoff = (now || Date.now()) - STALE_MS;
        return entries.filter((e) => new Date(e.created_at).getTime() <= cutoff);
      },
      /**
       * Try to send everything that is not stale. `send` is the transport's
       * broadcast(payload, clientRequestId) — reusing the entry id as the
       * idempotency key is what stops a double flush creating two cases.
       */
      async flush(send, now) {
        if (!entries.length) return { sent: [], kept: entries.length, stale: this.stale(now).length };
        const cutoff = (now || Date.now()) - STALE_MS;
        const sent = [];
        const keep = [];
        for (const entry of entries) {
          if (new Date(entry.created_at).getTime() <= cutoff) {
            keep.push(entry);
            continue;
          }
          try {
            const res = await send(entry.payload, entry.id);
            sent.push({ entry, response: res });
          } catch (err) {
            entry.attempts += 1;
            entry.last_attempt_at = (/* @__PURE__ */ new Date()).toISOString();
            entry.last_error = err && err.message || "unknown";
            if (err && err.status >= 400 && err.status < 500) {
              if (opts.onRejected) opts.onRejected(entry, err);
            } else {
              keep.push(entry);
            }
          }
        }
        entries = keep;
        persist();
        return { sent, kept: entries.length, stale: this.stale(now).length };
      }
    };
  }
  const CASES_KEY = "goldenhour.cases";
  const MAX_KEPT = 12;
  const OPEN_STATUSES = ["PENDING", "ACCEPTED"];
  const RECENT_ARRIVAL_MS = 5 * 60 * 1e3;
  function createCaseBook(storage) {
    let items = read();
    function read() {
      try {
        const raw = storage.getItem(CASES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(0, MAX_KEPT) : [];
      } catch (_) {
        return [];
      }
    }
    function persist() {
      try {
        storage.setItem(CASES_KEY, JSON.stringify(items.slice(0, MAX_KEPT)));
      } catch (_) {
      }
    }
    return {
      all() {
        return items.slice();
      },
      /** The one case the crew is currently running, if any. */
      active() {
        return items.find((c) => OPEN_STATUSES.indexOf(c.status) !== -1) || null;
      },
      /**
       * What the Home screen should show.
       *
       * An open case, or — when there is none — a case that arrived in the last
       * few minutes. Without the second half, tapping "Reached hospital" made
       * the entire card vanish along with the confirmation that the arrival had
       * been recorded at all, which is the one moment the crew most needs to
       * see it. It clears itself; nothing has to be dismissed.
       */
      current(now) {
        const open = this.active();
        if (open) return open;
        const cutoff = (now || Date.now()) - RECENT_ARRIVAL_MS;
        return items.find((c) => c.status === "ARRIVED" && new Date(c.updated_at || c.created_at).getTime() > cutoff) || null;
      },
      get(caseCode) {
        return items.find((c) => c.case_code === caseCode) || null;
      },
      record(entry) {
        const existing = items.find((c) => c.case_code === entry.case_code);
        if (existing) {
          Object.assign(existing, entry, { updated_at: (/* @__PURE__ */ new Date()).toISOString() });
        } else {
          items.unshift(Object.assign({
            created_at: (/* @__PURE__ */ new Date()).toISOString(),
            updated_at: (/* @__PURE__ */ new Date()).toISOString(),
            status: "PENDING"
          }, entry));
          items = items.slice(0, MAX_KEPT);
        }
        persist();
        return this.get(entry.case_code);
      },
      setStatus(caseCode, status, extra) {
        const c = this.get(caseCode);
        if (!c) return null;
        c.status = status;
        c.updated_at = (/* @__PURE__ */ new Date()).toISOString();
        if (extra) Object.assign(c, extra);
        persist();
        return c;
      },
      clear() {
        items = [];
        persist();
      }
    };
  }
  const STATUS_TEXT = {
    PENDING: "Waiting for a hospital",
    ACCEPTED: "Accepted — en route",
    ARRIVED: "Arrived",
    EXPIRED: "No hospital accepted",
    REJECTED: "Declined by all",
    CANCELLED: "Cancelled",
    QUEUED: "Queued — no signal"
  };
  const STATUS_TONE = {
    PENDING: "caution",
    ACCEPTED: "good",
    ARRIVED: "good",
    EXPIRED: "critical",
    REJECTED: "critical",
    CANCELLED: "muted",
    QUEUED: "caution"
  };
  function describeWhen(iso, now) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const mins = Math.floor((Date.now() - t) / 6e4);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours === 1 ? "1 hour ago" : hours + " hours ago";
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }
  const PUBLIC_API = {
    MAX_IMAGES,
    VITAL_KEYS,
    DEMO_CASE_TYPES,
    CATEGORY_LABELS,
    AGE_BANDS,
    ageBandById,
    describeAgeBand,
    ageBandLabel,
    getBandFor,
    isOutOfRange,
    toNumberOrNull,
    toTextOrNull,
    buildPayload,
    deriveNeeds,
    categoryOf
  };
  try {
    if (typeof module !== "undefined" && module && typeof module.exports === "object") {
      module.exports = PUBLIC_API;
    }
  } catch (_) {
  }
  if (typeof window !== "undefined") window.GH = PUBLIC_API;
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    if (document.getElementById("app")) start();
    else document.addEventListener("DOMContentLoaded", start);
  }
  function start() {
    try {
      boot(window, document);
    } catch (err) {
      try {
        const banner = document.getElementById("loadError");
        const text = document.getElementById("loadErrorText");
        if (text) text.textContent = "The app failed to start: " + (err && err.message || err);
        if (banner) banner.hidden = false;
      } catch (_) {
      }
      if (window.console && console.error) console.error("[GoldenHour] boot failed", err);
    }
  }
  function boot(win, doc) {
    const $ = (id) => doc.getElementById(id);
    const $$ = (sel) => Array.prototype.slice.call(doc.querySelectorAll(sel));
    const on = (el, evt, fn) => {
      if (el) el.addEventListener(evt, fn);
    };
    const storage = safeStorage(win);
    const env = resolveEnvironment({
      config: win.GH_CONFIG,
      location: win.location,
      capacitor: isCapacitorRuntime(win),
      forceDemo: typeof win.__GH_DEMO === "boolean" ? win.__GH_DEMO : void 0
    });
    const pollMs = () => Number(win.__GH_POLL_MS) > 0 ? Number(win.__GH_POLL_MS) : env.pollMs;
    const transport = env.demo ? createDemoTransport({
      caseTypes: DEMO_CASE_TYPES,
      postMs: () => Number(win.__GH_DEMO_POST_MS) || 300,
      shouldFail: () => !!win.__GH_DEMO_FAIL
    }) : createLiveTransport(env.apiRoot || "", (url, opts) => {
      if (typeof win.fetch !== "function") return Promise.reject(new NetworkError("No fetch in this runtime"));
      return win.fetch(url, opts);
    });
    const outbox = createOutbox(storage, {
      onRejected: (entry) => toast("A queued case was refused by the server and discarded")
    });
    const caseBook = createCaseBook(storage);
    const state = {
      demo: env.demo,
      caseTypes: DEMO_CASE_TYPES.slice(),
      selected: { caseTypeId: null, category: null, gender: "U", ageBand: "unknown", bloodGroup: null, consciousness: null, radiusKm: 15 },
      /* "Has a person actually chosen this?" — distinct from the value, which
         always has a safe default so nothing can be blocked by it. */
      touched: { age: false, gender: false },
      fastState: { face: false, arm: false, speech: false },
      needs: { ventilator: false, blood: false, imaging: false, ot: false, cathlab: false },
      needsTouched: false,
      location: { lat: null, lng: null, accuracy: null, source: null, status: "locating" },
      images: [],
      activeCaseCode: null,
      lastResponse: null,
      lastPayload: null,
      lastClientRequestId: null
    };
    let pollTimer = null;
    let flushTimer = null;
    let socket = null;
    let geoWatch = null;
    const VIEWS = { home: "homeView", new: "formScroll", cases: "casesView", settings: "settingsView" };
    const VIEW_IDS = ["homeView", "formScroll", "casesView", "settingsView"];
    function showView(name) {
      const target = VIEWS[name] || VIEWS.home;
      VIEW_IDS.forEach((id) => {
        const el2 = $(id);
        if (el2) el2.hidden = id !== target;
      });
      $$("#tabbar .tab").forEach((t) => {
        const isOn = t.dataset.view === name;
        t.classList.toggle("is-on", isOn);
        if (isOn) t.setAttribute("aria-current", "page");
        else t.removeAttribute("aria-current");
      });
      if (name === "home") renderHome();
      if (name === "cases") renderCaseList();
      if (name === "settings") renderSettings();
      const el = $(target);
      if (el && typeof el.scrollTo === "function") el.scrollTo({ top: 0 });
      else if (el) el.scrollTop = 0;
    }
    on($("tabbar"), "click", (e) => {
      const t = e.target.closest(".tab");
      if (t) showView(t.dataset.view);
    });
    on($("startAlertBtn"), "click", () => showView("new"));
    $$(".quick-row").forEach((row) => on(row, "click", () => {
      const go = row.dataset.go;
      if (go === "active") {
        showView("home");
        const box = $("activeCaseBox");
        if (box && !box.hidden && box.scrollIntoView) box.scrollIntoView({ block: "start" });
      } else showView(go === "new" ? "new" : "cases");
    }));
    on($("continueCaseBtn"), "click", () => {
      if (state.lastResponse) $("successOverlay").hidden = false;
      else showView("new");
    });
    function renderCaseTypes() {
      const sel = $("caseType");
      const quick = $("quickCase");
      if (!sel) return;
      const keep = sel.value;
      sel.textContent = "";
      const placeholder = doc.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a case type…";
      sel.appendChild(placeholder);
      CATEGORY_LABELS.forEach(([key, label]) => {
        const inGroup = state.caseTypes.filter((t) => t.category === key);
        if (!inGroup.length) return;
        const group = doc.createElement("optgroup");
        group.label = label;
        inGroup.forEach((t) => {
          const opt = doc.createElement("option");
          opt.value = String(t.id);
          opt.textContent = t.label;
          group.appendChild(opt);
        });
        sel.appendChild(group);
      });
      const known = CATEGORY_LABELS.map((c) => c[0]);
      const others = state.caseTypes.filter((t) => known.indexOf(t.category) === -1);
      if (others.length) {
        const group = doc.createElement("optgroup");
        group.label = "Other";
        others.forEach((t) => {
          const opt = doc.createElement("option");
          opt.value = String(t.id);
          opt.textContent = t.label;
          group.appendChild(opt);
        });
        sel.appendChild(group);
      }
      sel.value = keep;
      if (quick) {
        quick.textContent = "";
        state.caseTypes.filter((t) => t.quick).forEach((t) => {
          const b = doc.createElement("button");
          b.type = "button";
          b.className = "chip chip-xs";
          b.setAttribute("data-case-id", String(t.id));
          b.textContent = t.short || t.label;
          quick.appendChild(b);
        });
      }
    }
    function selectCaseType(id) {
      const n = toNumberOrNull(id);
      state.selected.caseTypeId = n;
      state.selected.category = categoryOf(state.caseTypes, n);
      const sel = $("caseType");
      if (sel) sel.value = n === null ? "" : String(n);
      $$("#quickCase .chip").forEach((c) => c.classList.toggle("is-on", toNumberOrNull(c.dataset.caseId) === n));
      const stroke = $("strokeSection");
      if (stroke) stroke.hidden = state.selected.category !== "STROKE";
      refreshNeeds();
      refreshSubmitHint();
    }
    on($("caseType"), "change", (e) => selectCaseType(e.target.value));
    on($("quickCase"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (chip) selectCaseType(chip.dataset.caseId);
    });
    async function loadCaseTypes() {
      try {
        const list = await transport.caseTypes();
        if (Array.isArray(list) && list.length) {
          state.caseTypes = list;
          renderCaseTypes();
          selectCaseType(state.selected.caseTypeId);
        }
        setLoadError(null);
      } catch (err) {
        setLoadError("Using the built-in case list — the server list could not be loaded.");
      }
    }
    function setLoadError(message) {
      const banner = $("loadError");
      const text = $("loadErrorText");
      if (!banner) return;
      if (!message) {
        banner.hidden = true;
        return;
      }
      if (text) text.textContent = message;
      banner.hidden = false;
    }
    on($("retryListsBtn"), "click", () => {
      setLoadError(null);
      loadCaseTypes();
    });
    function bindRadioGroup(containerId, attr, onPick) {
      const container = $(containerId);
      on(container, "click", (e) => {
        const b = e.target.closest("[" + attr + "]");
        if (!b || !container.contains(b)) return;
        container.querySelectorAll("[" + attr + "]").forEach((x) => {
          const isOn = x === b;
          x.classList.toggle("is-on", isOn);
          if (x.hasAttribute("role")) x.setAttribute("aria-checked", isOn ? "true" : "false");
        });
        onPick(b.getAttribute(attr), b);
      });
    }
    bindRadioGroup("genderSeg", "data-value", (v) => {
      state.selected.gender = v;
      state.touched.gender = true;
      markAnswered();
    });
    bindRadioGroup("consciousnessGroup", "data-value", (v) => {
      state.selected.consciousness = v;
      refreshNeeds();
    });
    ["fastFace", "fastArm", "fastSpeech"].forEach((id) => {
      bindRadioGroup(id, "data-yn", (v) => {
        state.fastState[id.replace("fast", "").toLowerCase()] = v === "yes";
      });
    });
    bindRadioGroup("editGender", "data-value", () => {
    });
    bindRadioGroup("editConsciousness", "data-value", () => {
    });
    on($("bloodChips"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const wasOn = chip.classList.contains("is-on");
      $$("#bloodChips .chip").forEach((c) => c.classList.remove("is-on"));
      if (wasOn) {
        state.selected.bloodGroup = null;
      } else {
        chip.classList.add("is-on");
        state.selected.bloodGroup = chip.dataset.blood;
      }
    });
    on($("editBloodRow"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const wasOn = chip.classList.contains("is-on");
      $$("#editBloodRow .chip").forEach((c) => c.classList.remove("is-on"));
      if (!wasOn) chip.classList.add("is-on");
    });
    function bindFillChips(containerId, dataKey, targetId, after) {
      on($(containerId), "click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        $$("#" + containerId + " .chip").forEach((c) => c.classList.toggle("is-on", c === chip));
        const target = $(targetId);
        if (target) target.value = chip.dataset[dataKey];
        if (after) after(chip.dataset[dataKey]);
      });
    }
    bindFillChips("etaChips", "eta", "eta");
    bindFillChips("onsetChips", "onset", "onsetHours");
    bindFillChips("radiusChips", "radius", "radiusKm", (v) => setRadius(v));
    function setRadius(value) {
      const n = toNumberOrNull(value);
      if (n === null) return;
      state.selected.radiusKm = n;
      const out = $("radiusOut");
      if (out) out.textContent = n + " km";
      $$("#radiusChips .chip").forEach((c) => c.classList.toggle("is-on", toNumberOrNull(c.dataset.radius) === n));
    }
    on($("radiusKm"), "input", (e) => setRadius(e.target.value));
    on($("notes"), "input", (e) => {
      const count = $("notesCount");
      if (count) count.textContent = String(e.target.value.length) + " / 160";
    });
    on($("ambulanceId"), "change", (e) => {
      try {
        storage.setItem("goldenhour.ambulanceId", e.target.value);
      } catch (_) {
      }
    });
    try {
      const savedUnit = storage.getItem("goldenhour.ambulanceId");
      if (savedUnit && $("ambulanceId")) $("ambulanceId").value = savedUnit;
    } catch (_) {
    }
    function renderAgeBands(containerId) {
      const wrap = $(containerId);
      if (!wrap) return;
      wrap.textContent = "";
      AGE_BANDS.forEach((band) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "band";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", "false");
        b.setAttribute("data-age-band", band.id);
        if (band.value !== null) b.setAttribute("data-age", String(band.value));
        const label = doc.createElement("b");
        label.textContent = band.label;
        const hint = doc.createElement("small");
        hint.textContent = band.hint;
        b.appendChild(label);
        b.appendChild(hint);
        wrap.appendChild(b);
      });
    }
    function paintAgeBands(containerId, bandId) {
      $$("#" + containerId + " .band").forEach((b) => {
        const isOn = b.dataset.ageBand === bandId;
        b.classList.toggle("is-on", isOn);
        b.setAttribute("aria-checked", isOn ? "true" : "false");
        b.tabIndex = isOn ? 0 : -1;
      });
    }
    function setAgeBand(bandId, opts) {
      const band = ageBandById(bandId);
      if (!band) return;
      state.selected.ageBand = band.id;
      if (!opts || opts.touched !== false) state.touched.age = true;
      const field = $("age");
      if (field) field.value = band.value === null ? "" : String(band.value);
      paintAgeBands("ageChips", band.id);
      markAnswered();
      refreshNeeds();
    }
    on($("ageChips"), "click", (e) => {
      const b = e.target.closest(".band");
      if (b) setAgeBand(b.dataset.ageBand);
    });
    ["ageChips", "editAgeChips"].forEach((id) => {
      on($(id), "keydown", (e) => {
        const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
        if (!keys.includes(e.key)) return;
        const buttons = Array.from($(id).querySelectorAll(".band"));
        const index = buttons.indexOf(e.target.closest(".band"));
        if (index < 0) return;
        e.preventDefault();
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].click();
        buttons[next].focus();
      });
    });
    function markAnswered() {
      const age = $("ageChips");
      const sex = $("genderSeg");
      if (age) age.classList.toggle("needs-answer", !state.touched.age);
      if (sex) sex.classList.toggle("needs-answer", !state.touched.gender);
    }
    const VITAL_FIELDS = [
      ["systolicBp", "sysChip"],
      ["diastolicBp", "diaChip"],
      ["heartRate", "hrChip"],
      ["respRate", "rrChip"],
      ["spo2", "spo2Chip"],
      ["glucose", "glcChip"]
    ];
    const BAND_WORD = { good: "Normal", caution: "Caution", critical: "Critical" };
    const VITAL_PREFIX = { systolicBp: "Systolic ", diastolicBp: "Diastolic " };
    const QUIET_WHEN_GOOD = ["systolicBp", "diastolicBp"];
    function paintVital(inputId, chipId) {
      const input = $(inputId);
      const chip = $(chipId);
      if (!input || !chip) return;
      const raw = input.value;
      const prefix = VITAL_PREFIX[inputId] || "";
      input.classList.remove("in-good", "in-caution", "in-critical", "in-range");
      if (toNumberOrNull(raw) === null) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      if (isOutOfRange(inputId, raw)) {
        chip.hidden = false;
        chip.className = "chip-state state-range";
        chip.textContent = prefix ? prefix + "out of range" : "Check value";
        input.classList.add("in-range");
        return;
      }
      const band = getBandFor(inputId, raw);
      if (!band) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      input.classList.add("in-" + band);
      if (band === "good" && QUIET_WHEN_GOOD.indexOf(inputId) !== -1) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      chip.hidden = false;
      chip.className = "chip-state state-" + band;
      chip.textContent = prefix ? prefix + BAND_WORD[band].toLowerCase() : BAND_WORD[band];
    }
    function readVitals() {
      const out = {};
      VITAL_FIELDS.forEach(([inputId]) => {
        const el = $(inputId);
        out[inputId] = el ? el.value : "";
      });
      return out;
    }
    VITAL_FIELDS.forEach(([inputId, chipId]) => {
      on($(inputId), "input", () => {
        paintVital(inputId, chipId);
        paintBpSummary();
        refreshNeeds();
      });
    });
    function repaintAllVitals() {
      VITAL_FIELDS.forEach(([i, c]) => paintVital(i, c));
      paintBpSummary();
    }
    function paintBpSummary() {
      const chip = $("bpChip");
      if (!chip) return;
      const sys = $("systolicBp") ? $("systolicBp").value : "";
      const dia = $("diastolicBp") ? $("diastolicBp").value : "";
      if (toNumberOrNull(sys) === null && toNumberOrNull(dia) === null) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      if (isOutOfRange("systolicBp", sys) || isOutOfRange("diastolicBp", dia)) {
        chip.hidden = false;
        chip.className = "chip-state state-range";
        chip.textContent = "Check value";
        return;
      }
      const bands = [getBandFor("systolicBp", sys), getBandFor("diastolicBp", dia)].filter(Boolean);
      if (!bands.length) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      const worst = bands.indexOf("critical") !== -1 ? "critical" : bands.indexOf("caution") !== -1 ? "caution" : "good";
      chip.hidden = false;
      chip.className = "chip-state state-" + worst;
      chip.textContent = BAND_WORD[worst];
    }
    const NEED_BUTTONS = { ventilator: "needVent", blood: "needBlood", imaging: "needImaging", ot: "needOt", cathlab: "needCath" };
    function refreshNeeds() {
      if (state.needsTouched) return paintNeeds();
      const v = readVitals();
      state.needs = deriveNeeds({
        category: state.selected.category,
        consciousness: state.selected.consciousness,
        vitals: { spo2: v.spo2, systolic_bp: v.systolicBp }
      });
      paintNeeds();
    }
    function paintNeeds() {
      Object.keys(NEED_BUTTONS).forEach((key) => {
        const b = $(NEED_BUTTONS[key]);
        if (!b) return;
        b.classList.toggle("is-on", !!state.needs[key]);
        b.setAttribute("aria-pressed", state.needs[key] ? "true" : "false");
      });
    }
    on($("needsChips"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const key = chip.dataset.need;
      if (!(key in state.needs)) return;
      state.needs[key] = !state.needs[key];
      state.needsTouched = true;
      paintNeeds();
    });
    function setLocation(fix) {
      state.location = {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy === void 0 ? null : fix.accuracy,
        source: fix.source,
        status: "ready"
      };
      const box = $("locBox");
      const measured = fix.source === "gps";
      if (box) box.className = "locbox " + (measured || fix.source === "demo" ? "loc-ready" : "loc-manual");
      const status = $("locationStatus");
      const meta = $("locationMeta");
      if (status) {
        status.textContent = fix.source === "gps" ? "GPS fix ready" : fix.source === "demo" ? "Demo position locked" : fix.source === "last-known" ? "Using the last fix from this shift" : "Using coordinates set by hand";
      }
      if (meta) {
        meta.textContent = measured && fix.accuracy != null ? "±" + Math.round(fix.accuracy) + " m · " + fix.lat.toFixed(4) + ", " + fix.lng.toFixed(4) : fix.lat.toFixed(4) + ", " + fix.lng.toFixed(4) + " · " + (SOURCE_LABELS[fix.source] || fix.source);
      }
      const fallback = $("locFallback");
      if (fallback) fallback.hidden = true;
      const retry = $("locRetryBtn");
      if (retry) retry.hidden = true;
      refreshSubmitHint();
    }
    function setLocationFailed(message) {
      state.location = { lat: null, lng: null, accuracy: null, source: null, status: "unavailable" };
      const box = $("locBox");
      if (box) box.className = "locbox loc-error";
      const status = $("locationStatus");
      if (status) status.textContent = message;
      const meta = $("locationMeta");
      if (meta) meta.textContent = "No position yet";
      const retry = $("locRetryBtn");
      if (retry) retry.hidden = false;
      renderFallbackChips();
      const fallback = $("locFallback");
      if (fallback) fallback.hidden = false;
      refreshSubmitHint();
    }
    function renderFallbackChips() {
      const wrap = $("locFallbackChips");
      if (!wrap) return;
      wrap.textContent = "";
      const last = readLastFix(storage, Date.now());
      if (last) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "chip chip-xs";
        b.textContent = "Last fix · " + describeAge(last.age);
        b.addEventListener("click", () => setLocation({ lat: last.lat, lng: last.lng, accuracy: null, source: "last-known" }));
        wrap.appendChild(b);
      }
      const preset = env.fallbackOrigin;
      if (preset && toNumberOrNull(preset.lat) !== null) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "chip chip-xs";
        b.textContent = preset.label || "Use city centre";
        b.addEventListener("click", () => setLocation({
          lat: Number(preset.lat),
          lng: Number(preset.lng),
          accuracy: null,
          source: "manual"
        }));
        wrap.appendChild(b);
      }
    }
    function useTypedCoordinates() {
      const coords = validCoords($("manualLat") && $("manualLat").value, $("manualLng") && $("manualLng").value);
      if (!coords) {
        toast("Those coordinates are not valid — check the latitude and longitude");
        return false;
      }
      setLocation({ lat: coords.lat, lng: coords.lng, accuracy: null, source: "manual" });
      return true;
    }
    on($("useManualBtn"), "click", useTypedCoordinates);
    function locate() {
      if (state.demo) {
        setLocation({ lat: 12.9716, lng: 77.5946, accuracy: null, source: "demo" });
        return;
      }
      const geo = isCapacitorRuntime(win) ? {
        getCurrentPosition: (success, failure, options) => {
          Geolocation$1.requestPermissions({ permissions: ["location"] }).then((permission) => {
            if (permission.location !== "granted") throw new Error("Precise location permission is required");
            return Geolocation$1.getCurrentPosition(options);
          }).then(success, failure);
        }
      } : win.navigator && win.navigator.geolocation;
      if (!geo || typeof geo.getCurrentPosition !== "function") {
        setLocationFailed(noGeolocationMessage());
        return;
      }
      state.location.status = "locating";
      const status = $("locationStatus");
      if (status) status.textContent = "Locating device…";
      try {
        geo.getCurrentPosition(
          (pos) => {
            const c = pos && pos.coords;
            const coords = validCoords(c && c.latitude, c && c.longitude);
            if (!coords) {
              setLocationFailed("The device returned an impossible position. Pick a starting point below.");
              return;
            }
            const accuracy = toNumberOrNull(c.accuracy);
            setLocation({ lat: coords.lat, lng: coords.lng, accuracy, source: "gps" });
            writeLastFix(storage, { lat: coords.lat, lng: coords.lng, accuracy });
          },
          (err) => setLocationFailed(describeGeoError(err)),
          { enableHighAccuracy: true, timeout: 8e3, maximumAge: 5e3 }
        );
      } catch (err) {
        setLocationFailed(noGeolocationMessage());
      }
    }
    on($("locRetryBtn"), "click", locate);
    function hasUsableLocation() {
      return state.location.status === "ready" && state.location.lat !== null && state.location.lng !== null;
    }
    function blockingReason() {
      if (state.selected.caseTypeId === null) return "Pick a case type to broadcast";
      if (!hasUsableLocation()) return "A position is needed before this can be sent";
      return null;
    }
    function refreshSubmitHint() {
      const hint = $("submitHint");
      const btn = $("submitBtn");
      if (!hint) return;
      const blocked = blockingReason();
      if (blocked) {
        hint.className = "submit-hint is-bad";
        hint.textContent = blocked;
      } else {
        hint.className = "submit-hint is-ok";
        const src = state.location.source;
        const detail = src === "gps" ? "GPS" + (state.location.accuracy != null ? " ±" + Math.round(state.location.accuracy) + " m" : "") : src === "demo" ? "demo position" : src === "last-known" ? "recalled fix, set by hand" : "position set by hand";
        hint.textContent = "Ready to broadcast · " + detail;
      }
      if (btn) btn.disabled = false;
    }
    function renderPhotos() {
      const grid = $("photoGrid");
      const count = $("photoCount");
      const add = $("addPhotoBtn");
      if (!grid) return;
      grid.querySelectorAll(".photo-tile").forEach((el) => el.remove());
      state.images.forEach((src, index) => {
        const tile = doc.createElement("div");
        tile.className = "photo-tile";
        const img = doc.createElement("img");
        img.alt = "Attached photo " + (index + 1);
        img.src = src;
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "photo-remove";
        remove.setAttribute("aria-label", "Remove photo " + (index + 1));
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          state.images.splice(index, 1);
          renderPhotos();
        });
        tile.appendChild(img);
        tile.appendChild(remove);
        grid.insertBefore(tile, add || null);
      });
      if (count) count.textContent = state.images.length + " / " + MAX_IMAGES;
      if (add) add.hidden = state.images.length >= MAX_IMAGES;
    }
    async function addImage(dataUrl) {
      if (!dataUrl || state.images.length >= MAX_IMAGES) return false;
      state.images.push(dataUrl);
      renderPhotos();
      return true;
    }
    on($("addPhotoBtn"), "click", () => {
      if (state.images.length >= MAX_IMAGES) {
        toast("Four photos is the limit");
        return;
      }
      openOverlay("photoSheet");
    });
    on($("photoCameraBtn"), "click", () => {
      closeOverlay("photoSheet");
      const i = $("cameraInput");
      if (i) i.click();
    });
    on($("photoGalleryBtn"), "click", () => {
      closeOverlay("photoSheet");
      const i = $("photoInput");
      if (i) i.click();
    });
    async function ingestFiles(e) {
      const files = Array.prototype.slice.call(e.target.files || []);
      let skipped = 0;
      for (const file of files) {
        if (state.images.length >= MAX_IMAGES) {
          skipped++;
          continue;
        }
        try {
          await addImage(await compressImage(file, 1280));
        } catch (_) {
          toast("That photo could not be read");
        }
      }
      if (skipped) toast(skipped + " photo" + (skipped === 1 ? "" : "s") + " skipped — four is the limit");
      e.target.value = "";
    }
    on($("photoInput"), "change", ingestFiles);
    on($("cameraInput"), "change", ingestFiles);
    function compressImage(file, maxSide) {
      return new Promise((resolve, reject) => {
        const reader = new win.FileReader();
        reader.onerror = () => reject(new Error("read failed"));
        reader.onload = () => {
          const raw = reader.result;
          let canvas;
          try {
            canvas = doc.createElement("canvas");
          } catch (_) {
            return resolve(raw);
          }
          if (!canvas.getContext) return resolve(raw);
          const img = new win.Image();
          img.onerror = () => resolve(raw);
          img.onload = () => {
            try {
              const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
              canvas.width = Math.round(img.width * scale);
              canvas.height = Math.round(img.height * scale);
              canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL("image/jpeg", 0.72));
            } catch (_) {
              resolve(raw);
            }
          };
          img.src = raw;
        };
        reader.readAsDataURL(file);
      });
    }
    function collectForm() {
      const v = readVitals();
      return {
        caseTypeId: state.selected.caseTypeId,
        category: state.selected.category,
        age: $("age") ? $("age").value : "",
        gender: state.selected.gender,
        bloodGroup: state.selected.bloodGroup,
        systolicBp: v.systolicBp,
        diastolicBp: v.diastolicBp,
        heartRate: v.heartRate,
        respRate: v.respRate,
        spo2: v.spo2,
        glucose: v.glucose,
        consciousness: state.selected.consciousness,
        lat: state.location.lat,
        lng: state.location.lng,
        accuracy: state.location.accuracy,
        originSource: state.location.source,
        radiusKm: state.selected.radiusKm,
        images: state.images,
        eta: $("eta") ? $("eta").value : "",
        notes: $("notes") ? $("notes").value : "",
        ambulanceId: $("ambulanceId") ? $("ambulanceId").value : "",
        face: state.fastState.face,
        arm: state.fastState.arm,
        speech: state.fastState.speech,
        onsetHours: $("onsetHours") ? $("onsetHours").value : ""
      };
    }
    async function submitLoop() {
      const blocked = blockingReason();
      if (blocked) {
        toast(state.selected.caseTypeId === null ? "Pick a case type first" : blocked);
        refreshSubmitHint();
        return null;
      }
      const payload = buildPayload(collectForm());
      win.__GH_LAST_PAYLOAD = payload;
      state.lastPayload = payload;
      const btn = $("submitBtn");
      if (btn) {
        btn.disabled = true;
        btn.classList.add("is-loading");
      }
      const crid = state.lastClientRequestId || "cr-" + Date.now() + "-" + Math.floor(Math.random() * 1e6).toString(36);
      state.lastClientRequestId = crid;
      try {
        const res = await transport.broadcast(payload, crid);
        state.lastResponse = res;
        state.activeCaseCode = res.id;
        state.lastClientRequestId = null;
        setNetPill(state.demo ? "demo" : "live");
        recordCase(res, payload, "PENDING");
        openSuccess(res, payload);
        startPolling(res.id);
        followCase(res.id);
        return res;
      } catch (err) {
        if (err && err.network && !state.demo) queueForLater(payload);
        else showError(err && err.message || "The server refused this case.");
        return null;
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("is-loading");
        }
      }
    }
    function queueForLater(payload, err) {
      const queued = outbox.enqueue(payload);
      if (!queued) {
        showError("No signal, and this case could not be queued on the device. Please retry.");
        return;
      }
      setNetPill("offline");
      renderOutbox();
      const info = $("outboxInfo");
      if (info) info.textContent = "No signal. This case is queued and sends itself the moment you have a connection.";
      $("successOverlay").hidden = true;
      openOverlay("outboxOverlay");
      recordCase({ id: queued.id }, payload, "QUEUED");
    }
    on($("submitBtn"), "click", () => {
      submitLoop();
    });
    const overlayReturn = {};
    function openOverlay(id) {
      const el = $(id);
      if (!el) return;
      overlayReturn[id] = doc.activeElement;
      el.hidden = false;
      const focusable = el.querySelector("button, [href], input, select, textarea");
      if (focusable && typeof focusable.focus === "function") {
        try {
          focusable.focus({ preventScroll: true });
        } catch (_) {
          focusable.focus();
        }
      }
    }
    function closeOverlay(id) {
      const el = $(id);
      if (!el || el.hidden) return;
      el.hidden = true;
      const back = overlayReturn[id];
      overlayReturn[id] = null;
      if (back && doc.contains(back) && typeof back.focus === "function") {
        try {
          back.focus({ preventScroll: true });
        } catch (_) {
          back.focus();
        }
      }
    }
    function topOverlay() {
      return $$(".overlay").filter((el) => !el.hidden).pop() || null;
    }
    on(doc, "click", (e) => {
      const x = e.target.closest && e.target.closest("[data-close]");
      if (x) closeOverlay(x.getAttribute("data-close"));
    });
    on(doc, "keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = topOverlay();
      if (open && open.id) {
        closeOverlay(open.id);
        e.preventDefault();
      }
    });
    function openSuccess(res, payload) {
      const overlay = $("successOverlay");
      const info = $("broadcastInfo");
      if (info) {
        const count = Number(res.hospitals_notified) || 0;
        info.textContent = "Sent to " + count + " nearby hospital" + (count === 1 ? "" : "s") + " within " + payload.broadcast_radius_km + " km.";
      }
      updateStatusChip({ status: "PENDING" });
      const accepted = $("acceptedBox");
      if (accepted) accepted.hidden = true;
      ["callBtn", "navBtn"].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = true;
      });
      $("errorOverlay").hidden = true;
      if (overlay) openOverlay("successOverlay");
    }
    function showError(message) {
      const el = $("errorMessage");
      if (el) el.textContent = message || "The case could not be sent.";
      $("successOverlay").hidden = true;
      openOverlay("errorOverlay");
    }
    on($("backBtn"), "click", () => closeOverlay("errorOverlay"));
    on($("retryBtn"), "click", () => {
      closeOverlay("errorOverlay");
      submitLoop();
    });
    on($("newRequestBtn"), "click", () => {
      closeOverlay("successOverlay");
      resetForNewCase();
      showView("new");
    });
    on($("retryConnBtn"), "click", () => {
      $("demoBanner").hidden = true;
      loadCaseTypes();
    });
    on($("outboxPill"), "click", () => openOverlay("outboxOverlay"));
    on($("tryFlushBtn"), "click", () => flushOutbox());
    on($("discardQueuedBtn"), "click", () => {
      outbox.clear();
      renderOutbox();
      closeOverlay("outboxOverlay");
    });
    function updateStatusChip(body) {
      const chip = $("statusChip");
      const text = $("statusChipText");
      const accepted = $("acceptedBox");
      if (!chip || !text) return;
      const status = body && body.status;
      if (status === "ACCEPTED" || status === "ARRIVED") {
        chip.className = "status-chip status-accepted";
        const name = body.accepted_hospital && body.accepted_hospital.name || body.accepted_by || "a hospital";
        text.textContent = status === "ARRIVED" ? "Arrived at " + name : "Accepted by " + name;
        if (body.accepted_hospital) paintAcceptedHospital(body.accepted_hospital, body.priority);
        return;
      }
      if (status === "EXPIRED" || status === "REJECTED" || status === "CANCELLED") {
        chip.className = "status-chip status-failed";
        text.textContent = status === "CANCELLED" ? "Cancelled" : "No hospital accepted";
        if (accepted) accepted.hidden = true;
        return;
      }
      chip.className = "status-chip status-pending";
      text.textContent = "Waiting for a hospital to accept…";
      if (accepted) accepted.hidden = true;
    }
    function paintAcceptedHospital(hospital, priority) {
      const box = $("acceptedBox");
      const name = $("acceptedName");
      const meta = $("acceptedMeta");
      if (name) name.textContent = hospital.name || "—";
      if (meta) {
        const bits = [];
        if (priority) bits.push(priority);
        if (hospital.distance_km != null) bits.push(Number(hospital.distance_km).toFixed(1) + " km");
        if (hospital.phone) bits.push("☎ " + hospital.phone);
        meta.textContent = bits.join(" · ");
      }
      if (box) box.hidden = false;
      const call = $("callBtn");
      if (call) {
        if (hospital.phone) {
          call.setAttribute("href", "tel:" + hospital.phone);
          call.hidden = false;
        } else call.hidden = true;
      }
      const nav = $("navBtn");
      if (nav) {
        if (hospital.lat != null && hospital.lng != null) {
          nav.setAttribute("href", "geo:" + hospital.lat + "," + hospital.lng + "?q=" + hospital.lat + "," + hospital.lng + "(" + encodeURIComponent(hospital.name || "Hospital") + ")");
          nav.hidden = false;
        } else nav.hidden = true;
      }
    }
    function stopPolling() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      if (socket) {
        try {
          socket.disconnect();
        } catch (_) {
        }
        socket = null;
      }
      if (geoWatch != null) {
        try {
          geoWatch();
        } catch (_) {
        }
        geoWatch = null;
      }
    }
    function startPolling(caseCode) {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const body = await transport.status(caseCode);
          applyStatus(body);
          if (body.status === "ARRIVED" || body.status === "EXPIRED" || body.status === "REJECTED" || body.status === "CANCELLED") {
            stopped = true;
            return;
          }
        } catch (_) {
        }
        if (!stopped) pollTimer = setTimeout(tick, pollMs());
      };
      pollTimer = setTimeout(tick, pollMs());
    }
    function applyStatus(body) {
      if (!body) return;
      updateStatusChip(body);
      if (state.activeCaseCode) {
        const extra = {};
        const acceptedBy = body.accepted_hospital && body.accepted_hospital.name || body.accepted_by;
        if (acceptedBy) extra.accepted_by = acceptedBy;
        if (body.live_eta_minutes != null) extra.eta_minutes = body.live_eta_minutes;
        if (body.eta_source) extra.eta_source = body.eta_source;
        caseBook.setStatus(state.activeCaseCode, body.status, extra);
      }
      if (body.status === "ACCEPTED") startSharingPosition();
      if (["ARRIVED", "CANCELLED", "EXPIRED", "REJECTED"].includes(body.status)) stopSharingPosition();
      if (body.status === "ACCEPTED") paintTracking(body);
      if (body.status === "ARRIVED") {
        const banner = $("arrivedBanner");
        if (banner) banner.hidden = false;
        stopSharingPosition();
      }
      renderHome();
    }
    function followCase(caseCode) {
      if (state.demo || !env.realtime || !win.io) return;
      try {
        socket = win.io(env.serverBase || void 0, { transports: ["websocket", "polling"] });
      } catch (_) {
        socket = null;
        return;
      }
      socket.on("connect", () => socket.emit("case:follow", caseCode));
      socket.on("case:status", (body) => applyStatus(normaliseStatus(body)));
      socket.on("case:position", (body) => paintTracking(body));
      socket.on("disconnect", () => {
        const t = $("trackingText");
        if (t) t.textContent = "Disconnected — hospital is not receiving location updates";
      });
      socket.on("patient:updated", () => {
        const t = $("updateTicker");
        if (!t) return;
        t.textContent = "Patient details updated";
        setTimeout(() => {
          t.textContent = "";
        }, 2400);
      });
    }
    function normaliseStatus(body) {
      return body || {};
    }
    function startSharingPosition(body) {
      const tracking = $("activeTracking");
      if (tracking) tracking.hidden = false;
      if (state.demo || geoWatch != null) return;
      const geo = win.navigator && win.navigator.geolocation;
      if (!socket) {
        const t = $("trackingText");
        if (t) t.textContent = "Live tracking unavailable — realtime connection is required";
        return;
      }
      const code = state.activeCaseCode;
      const text = $("trackingText");
      if (text) text.textContent = "Waiting for GPS and server confirmation…";
      let lastSent = 0;
      geoWatch = watchPosition({
        native: isCapacitorRuntime(win),
        plugin: Geolocation$1,
        geolocation: geo,
        onPosition: (pos) => {
          if (state.activeCaseCode !== code || (caseBook.get(code) || {}).status !== "ACCEPTED") return;
          if (!socket || !socket.connected) {
            if (text) text.textContent = "Disconnected — hospital is not receiving location updates";
            return;
          }
          const now = Date.now();
          if (now - lastSent < 1e4) return;
          const c = pos && pos.coords;
          const coords = validCoords(c && c.latitude, c && c.longitude);
          const timestamp = pos && pos.timestamp;
          if (!coords || !Number.isFinite(timestamp) || now - timestamp > 3e4 || timestamp > now + 3e4 || c.accuracy > 200) {
            if (text) text.textContent = "Waiting for a fresh, accurate GPS fix…";
            return;
          }
          lastSent = now;
          let confirmed = false;
          const timer = setTimeout(() => {
            if (!confirmed && text && state.activeCaseCode === code) text.textContent = "Location delivery unconfirmed — waiting for connection";
          }, 6e3);
          socket.volatile.emit("ambulance:position", {
            case_code: code,
            lat: coords.lat,
            lng: coords.lng,
            accuracy_m: toNumberOrNull(c.accuracy),
            speed_kmh: c.speed != null && c.speed >= 0 ? Math.round(c.speed * 3.6) : null,
            source: "gps",
            at: new Date(timestamp).toISOString()
          }, (ack) => {
            confirmed = true;
            clearTimeout(timer);
            if (state.activeCaseCode !== code || (caseBook.get(code) || {}).status !== "ACCEPTED") return;
            if (text) text.textContent = ack && ack.success ? "GPS location delivered to the accepting hospital" : "Location was not accepted — waiting for a fresh fix";
          });
        },
        onError: (err) => {
          if (text) text.textContent = "GPS unavailable — check location permission and keep the app open";
        }
      });
    }
    on($("retryTrackingBtn"), "click", () => {
      if ((caseBook.get(state.activeCaseCode) || {}).status !== "ACCEPTED") return;
      stopSharingPosition();
      startSharingPosition();
    });
    function stopSharingPosition() {
      const tracking = $("activeTracking");
      if (tracking) tracking.hidden = true;
      if (geoWatch != null) {
        try {
          geoWatch();
        } catch (_) {
        }
        geoWatch = null;
      }
    }
    function paintTracking(body) {
      const text = $("trackingText");
      const eta = $("activeEta");
      if (body && body.live_eta_minutes != null && eta) eta.textContent = body.live_eta_minutes + " min";
      if (!text || !body) return;
      if (body.eta_source === "stale") {
        text.textContent = "Location is stale — hospital is waiting for a fresh GPS fix";
        if (eta) eta.textContent = "Unavailable";
        return;
      }
      if (!socket || !socket.connected) {
        text.textContent = "Disconnected — hospital is not receiving location updates";
        return;
      }
      if (!body.position_at && !body.at) return;
      text.textContent = ["stalled", "stationary"].includes(body.eta_source) ? "Not moving — tell the hospital if you are delayed" : "Sharing location with the accepting hospital" + (body.live_eta_minutes != null ? " · " + body.live_eta_minutes + " min out" : "");
    }
    on($("delayedBtn"), "click", () => {
      if (!state.activeCaseCode || !socket) {
        toast("Not sharing location yet");
        return;
      }
      socket.emit("ambulance:delayed", { case_code: state.activeCaseCode, reason: "traffic" }, () => {
      });
      toast("The hospital has been told you are delayed");
    });
    let arrivalInFlight = false;
    on($("arrivedBtn"), "click", async () => {
      if (!state.activeCaseCode || arrivalInFlight) return;
      const entry = caseBook.get(state.activeCaseCode);
      if (entry && entry.status === "ARRIVED") {
        toast("Arrival is already recorded");
        return;
      }
      if (win.confirm && !win.confirm("Record arrival and close this case?")) return;
      arrivalInFlight = true;
      try {
        if (!state.demo) await recordArrival({ socket, fetch: win.fetch && win.fetch.bind(win), apiRoot: env.apiRoot, caseCode: state.activeCaseCode });
        stopSharingPosition();
        caseBook.setStatus(state.activeCaseCode, "ARRIVED");
        updateStatusChip({ status: "ARRIVED", accepted_by: (caseBook.get(state.activeCaseCode) || {}).accepted_by });
        const banner = $("arrivedBanner");
        if (banner) banner.hidden = false;
        toast("Arrival recorded");
        renderHome();
      } catch (err) {
        toast("Arrival could not be recorded — try again");
      } finally {
        arrivalInFlight = false;
      }
    });
    on($("editPatientBtn"), "click", () => {
      if (!state.activeCaseCode) {
        toast("No active case to update");
        return;
      }
      const p = state.lastPayload || {};
      const v = p.vitals || {};
      const setVal = (id, value) => {
        const el = $(id);
        if (el) el.value = value == null ? "" : String(value);
      };
      paintAgeBands("editAgeChips", describeAgeBand(p.age).id);
      paintRadio("editGender", "data-value", p.gender || "U");
      paintRadio("editConsciousness", "data-value", p.consciousness);
      paintChipRow("editBloodRow", "data-blood", p.blood_group);
      setVal("editSys", v.systolic_bp);
      setVal("editDia", v.diastolic_bp);
      setVal("editHr", v.heart_rate);
      setVal("editRr", v.resp_rate);
      setVal("editSpo2", v.spo2);
      setVal("editGlc", v.glucose);
      setVal("editNotes", p.notes);
      const status = $("editStatus");
      if (status) status.textContent = "";
      openOverlay("editOverlay");
    });
    on($("editCancelBtn"), "click", () => closeOverlay("editOverlay"));
    on($("editAgeChips"), "click", (e) => {
      const b = e.target.closest(".band");
      if (b) paintAgeBands("editAgeChips", b.dataset.ageBand);
    });
    function paintRadio(containerId, attr, value) {
      const c = $(containerId);
      if (!c) return;
      c.querySelectorAll("[" + attr + "]").forEach((x) => {
        const isOn = value != null && x.getAttribute(attr) === String(value);
        x.classList.toggle("is-on", isOn);
        if (x.hasAttribute("role")) x.setAttribute("aria-checked", isOn ? "true" : "false");
      });
    }
    function paintChipRow(containerId, attr, value) {
      const c = $(containerId);
      if (!c) return;
      c.querySelectorAll("[" + attr + "]").forEach((x) => {
        x.classList.toggle("is-on", value != null && x.getAttribute(attr) === String(value));
      });
    }
    on($("editSaveBtn"), "click", () => {
      const status = $("editStatus");
      if (!state.activeCaseCode) {
        if (status) status.textContent = "No active case.";
        return;
      }
      const selected = (sel) => {
        const el = doc.querySelector(sel);
        return el ? el : null;
      };
      const genderEl = selected("#editGender .seg-btn.is-on");
      const bloodEl = selected("#editBloodRow .chip.is-on");
      const consciousEl = selected("#editConsciousness .level.is-on");
      const bandEl = selected("#editAgeChips .band.is-on");
      const band = bandEl ? ageBandById(bandEl.dataset.ageBand) : null;
      const patch = {
        /* `null` is a real choice here — it is what "Unknown" means — so the
           key is sent whenever a band is selected, including that one. */
        age: band ? band.id === "unknown" ? null : describeAgeBand((state.lastPayload || {}).age).id === band.id ? (state.lastPayload || {}).age : band.value : void 0,
        gender: genderEl ? genderEl.dataset.value : void 0,
        blood_group: bloodEl ? bloodEl.dataset.blood : void 0,
        consciousness: consciousEl ? consciousEl.dataset.value : void 0,
        vitals: {
          systolic_bp: toNumberOrNull($("editSys").value),
          diastolic_bp: toNumberOrNull($("editDia").value),
          heart_rate: toNumberOrNull($("editHr").value),
          resp_rate: toNumberOrNull($("editRr").value),
          spo2: toNumberOrNull($("editSpo2").value),
          glucose: toNumberOrNull($("editGlc").value)
        },
        notes: toTextOrNull($("editNotes").value)
      };
      Object.keys(patch).forEach((k) => {
        if (patch[k] === void 0) delete patch[k];
      });
      if (state.demo) {
        applyLocalPatch(patch);
        if (status) status.textContent = "Saved on this device (demo mode).";
        setTimeout(() => closeOverlay("editOverlay"), 700);
        return;
      }
      if (!socket || !socket.connected) {
        if (status) status.textContent = "Not connected — the hospital has not seen this change. It will need resending.";
        return;
      }
      if (status) status.textContent = "Sending…";
      socket.emit("patient:update", { case_code: state.activeCaseCode, patient: patch }, (body) => {
        if (body && body.success) {
          applyLocalPatch(patch);
          if (status) status.textContent = "Saved. The hospital has it.";
          setTimeout(() => closeOverlay("editOverlay"), 700);
        } else if (status) {
          status.textContent = body && body.message || "The server refused this update.";
        }
      });
    });
    function applyLocalPatch(patch) {
      if (!state.lastPayload) return;
      if ("age" in patch) state.lastPayload.age = patch.age;
      if ("gender" in patch) state.lastPayload.gender = patch.gender;
      if ("blood_group" in patch) state.lastPayload.blood_group = patch.blood_group;
      if ("consciousness" in patch) state.lastPayload.consciousness = patch.consciousness;
      if ("notes" in patch) state.lastPayload.notes = patch.notes;
      if (patch.vitals) state.lastPayload.vitals = Object.assign({}, state.lastPayload.vitals, patch.vitals);
      if (state.activeCaseCode) {
        caseBook.record({
          case_code: state.activeCaseCode,
          age: state.lastPayload.age,
          gender: state.lastPayload.gender
        });
      }
      renderHome();
    }
    function renderOutbox() {
      const pill = $("outboxPill");
      const text = $("outboxText");
      const list = $("outboxList");
      const count = outbox.count();
      if (pill) pill.hidden = count === 0;
      if (text) text.textContent = count + " case" + (count === 1 ? "" : "s") + " queued";
      if (list) {
        list.textContent = "";
        outbox.all().forEach((entry) => {
          const row = doc.createElement("div");
          row.className = "recent-row";
          const main = doc.createElement("div");
          main.className = "recent-main";
          const title = doc.createElement("span");
          title.className = "recent-title";
          title.textContent = "Queued case";
          const meta = doc.createElement("span");
          meta.className = "recent-meta";
          meta.textContent = describeWhen(entry.created_at) + (entry.attempts ? " · " + entry.attempts + " attempt" + (entry.attempts === 1 ? "" : "s") : "") + (entry.photos_dropped ? " · photos dropped to fit" : "");
          main.appendChild(title);
          main.appendChild(meta);
          const status = doc.createElement("span");
          status.className = "recent-status tone-caution";
          status.textContent = "Queued";
          row.appendChild(main);
          row.appendChild(status);
          list.appendChild(row);
        });
      }
      if (count === 0) {
        const o = $("outboxOverlay");
        if (o) o.hidden = true;
      }
    }
    async function flushOutbox() {
      if (outbox.isEmpty() || state.demo) return;
      const stale = outbox.stale();
      if (stale.length) {
        const info = $("outboxInfo");
        if (info) {
          info.textContent = stale.length + " queued case" + (stale.length === 1 ? " has" : "s have") + " been waiting over 15 minutes. The patient may already be at a hospital — send or discard deliberately.";
        }
        if ($("outboxOverlay")) $("outboxOverlay").hidden = false;
      }
      try {
        const result = await outbox.flush((payload, id) => transport.broadcast(payload, id));
        if (result.sent.length) {
          toast(result.sent.length + " queued case" + (result.sent.length === 1 ? "" : "s") + " sent");
          setNetPill("live");
          const last = result.sent[result.sent.length - 1];
          state.activeCaseCode = last.response.id;
          state.lastResponse = last.response;
          recordCase(last.response, last.entry.payload, "PENDING");
          startPolling(last.response.id);
          followCase(last.response.id);
        }
      } catch (_) {
      }
      renderOutbox();
      renderHome();
    }
    function recordCase(res, payload, status) {
      const type = state.caseTypes.find((t) => Number(t.id) === Number(payload.case_type_id));
      caseBook.record({
        case_code: res.id,
        case_label: type ? type.short || type.label : "Case",
        age: payload.age,
        gender: payload.gender,
        status,
        eta_minutes: payload.eta_minutes
      });
      renderHome();
    }
    function renderHome() {
      const active = caseBook.current();
      const box = $("activeCaseBox");
      const quickActive = $("quickActiveSub");
      const quickRecent = $("quickRecentSub");
      const all = caseBook.all();
      if (quickRecent) {
        quickRecent.textContent = all.length ? all.length + " case" + (all.length === 1 ? "" : "s") + " on this device." : "Nothing yet this shift.";
      }
      if (!active) {
        if (box) box.hidden = true;
        if (quickActive) quickActive.textContent = "No case is running.";
      } else {
        if (box) box.hidden = false;
        if (quickActive) quickActive.textContent = active.case_label + " · " + (STATUS_TEXT[active.status] || active.status);
        const p = state.lastPayload || {};
        const v = p.vitals || {};
        const set = (id, value) => {
          const el = $(id);
          if (el) el.textContent = value === null || value === void 0 || value === "" ? "—" : String(value);
        };
        set("activeCaseCode", active.case_code);
        set("activePatientName", active.case_label);
        set("activeAgeBand", ageBandLabel(active.age));
        set("activeGenderLabel", { M: "Male", F: "Female", O: "Other", U: "Unknown" }[active.gender] || "Unknown");
        set("activeBlood", p.blood_group);
        set("activeCondition", p.consciousness);
        set("activeHr", v.heart_rate);
        set("activeBp", (v.systolic_bp || "—") + "/" + (v.diastolic_bp || "—"));
        set("activeSpo2", v.spo2);
        set("activeStatusText", STATUS_TEXT[active.status] || active.status);
        set("activeEta", active.eta_minutes != null ? active.eta_minutes + " min" : "— min");
        set("activeFacility", active.accepted_by || "Waiting for a hospital");
        const notes = $("activeNotes");
        if (notes) notes.textContent = p.notes || "No additional notes";
        const arrived = active.status === "ARRIVED";
        const accepted = active.status === "ACCEPTED";
        const arrivedBtn = $("arrivedBtn");
        if (arrivedBtn) {
          arrivedBtn.disabled = !accepted;
          arrivedBtn.hidden = arrived;
        }
        const banner = $("arrivedBanner");
        if (banner) banner.hidden = !arrived;
        ["editPatientBtn", "delayedBtn", "continueCaseBtn"].forEach((id) => {
          const el = $(id);
          if (el) el.hidden = arrived;
        });
        ["editPatientBtn", "delayedBtn"].forEach((id) => {
          const el = $(id);
          if (!el) return;
          el.disabled = !accepted;
          el.title = accepted ? "" : "Available once a hospital accepts this case";
        });
      }
      renderRecentInto("homeRecentList", 4);
    }
    function renderRecentInto(containerId, limit) {
      const list = $(containerId);
      if (!list) return;
      const all = caseBook.all().slice(0, limit || 50);
      list.textContent = "";
      if (!all.length) {
        const p = doc.createElement("p");
        p.className = "empty-note";
        p.textContent = "Cases you send appear here.";
        list.appendChild(p);
        return;
      }
      all.forEach((entry) => {
        const row = doc.createElement("div");
        row.className = "recent-row";
        const main = doc.createElement("div");
        main.className = "recent-main";
        const title = doc.createElement("span");
        title.className = "recent-title";
        title.textContent = entry.case_label || "Case";
        const meta = doc.createElement("span");
        meta.className = "recent-meta";
        const sex = { M: "Male", F: "Female", O: "Other" }[entry.gender] || "Sex not recorded";
        meta.textContent = ageBandLabel(entry.age) + " · " + sex + " · " + describeWhen(entry.created_at);
        main.appendChild(title);
        main.appendChild(meta);
        const status = doc.createElement("span");
        status.className = "recent-status tone-" + (STATUS_TONE[entry.status] || "muted");
        status.textContent = STATUS_TEXT[entry.status] || entry.status;
        row.appendChild(main);
        row.appendChild(status);
        list.appendChild(row);
      });
    }
    function renderCaseList() {
      renderRecentInto("caseList", 50);
    }
    function renderSettings() {
      const set = (id, value) => {
        const el = $(id);
        if (el) el.textContent = value;
      };
      set("setMode", state.demo ? "Demo — nothing is sent" : "Live");
      set("setBackend", env.serverBase || (state.demo ? "Not configured" : win.location && win.location.origin || "—"));
      set("setRealtime", env.realtime ? socket && socket.connected ? "Connected" : "Enabled" : "Off");
      set("setModeWhy", capitalise(env.reason) + ".");
      const queued = outbox.count();
      set("setOutboxSummary", queued ? queued + " case" + (queued === 1 ? "" : "s") + " waiting to send." : "Nothing is waiting to send.");
      const openBtn = $("setOutboxBtn");
      if (openBtn) openBtn.disabled = queued === 0;
      set("setCaseCount", String(caseBook.all().length));
    }
    function capitalise(text) {
      const t = String(text || "");
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
    }
    on($("setRecheckBtn"), "click", async () => {
      if (state.demo) {
        toast("This build has no backend configured");
        renderSettings();
        return;
      }
      await loadCaseTypes();
      toast("Connection re-checked");
      renderSettings();
    });
    on($("setOutboxBtn"), "click", () => {
      if (outbox.count()) openOverlay("outboxOverlay");
    });
    on($("setClearCasesBtn"), "click", () => {
      if (caseBook.active()) {
        toast("Finish or close the active case first");
        return;
      }
      if (win.confirm && !win.confirm("Clear the case history stored on this device?")) return;
      caseBook.clear();
      renderHome();
      renderCaseList();
      renderSettings();
      toast("Local case history cleared");
    });
    function resetForNewCase() {
      state.selected.caseTypeId = null;
      state.selected.category = null;
      state.selected.gender = "U";
      state.selected.ageBand = "unknown";
      state.touched = { age: false, gender: false };
      state.selected.bloodGroup = null;
      state.selected.consciousness = null;
      state.fastState = { face: false, arm: false, speech: false };
      state.needsTouched = false;
      state.images = [];
      state.lastClientRequestId = null;
      ["age", "systolicBp", "diastolicBp", "heartRate", "respRate", "spo2", "glucose", "eta", "onsetHours", "notes"].forEach((id) => {
        const el = $(id);
        if (el) el.value = "";
      });
      setAgeBand("unknown", { touched: false });
      const sel = $("caseType");
      if (sel) sel.value = "";
      const count = $("notesCount");
      if (count) count.textContent = "0 / 160";
      $$("#quickCase .chip, #bloodChips .chip, #etaChips .chip, #onsetChips .chip").forEach((c) => c.classList.remove("is-on"));
      resetRadioGroup("genderSeg", "data-value", "U");
      resetRadioGroup("consciousnessGroup", "data-value", null);
      ["fastFace", "fastArm", "fastSpeech"].forEach((id) => resetRadioGroup(id, "data-yn", "no"));
      setRadius(15);
      const stroke = $("strokeSection");
      if (stroke) stroke.hidden = true;
      repaintAllVitals();
      renderPhotos();
      refreshNeeds();
      markAnswered();
      locate();
      refreshSubmitHint();
    }
    function resetRadioGroup(containerId, attr, value) {
      const container = $(containerId);
      if (!container) return;
      container.querySelectorAll("[" + attr + "]").forEach((x) => {
        const isOn = value !== null && x.getAttribute(attr) === value;
        x.classList.toggle("is-on", isOn);
        if (x.hasAttribute("role")) x.setAttribute("aria-checked", isOn ? "true" : "false");
      });
    }
    let toastTimer = null;
    function toast(message) {
      const el = $("toast");
      if (!el) return;
      el.textContent = message;
      el.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.hidden = true;
      }, 3e3);
    }
    function setNetPill(mode) {
      const pill = $("netPill");
      if (!pill) return;
      pill.className = "pill " + (mode === "live" ? "pill-good" : mode === "demo" ? "pill-caution" : "pill-critical");
      pill.textContent = mode === "live" ? "Live" : mode === "demo" ? "Demo" : "Offline";
    }
    renderCaseTypes();
    renderAgeBands("ageChips");
    renderAgeBands("editAgeChips");
    setAgeBand("unknown", { touched: false });
    markAnswered();
    setRadius(15);
    repaintAllVitals();
    renderPhotos();
    refreshNeeds();
    renderOutbox();
    renderHome();
    renderSettings();
    locate();
    refreshSubmitHint();
    showView("home");
    if (state.demo) {
      setNetPill("demo");
      const banner = $("demoBanner");
      if (banner) banner.hidden = false;
    } else {
      setNetPill("live");
      const banner = $("demoBanner");
      if (banner) banner.hidden = true;
      loadCaseTypes();
      flushTimer = setInterval(() => {
        flushOutbox();
      }, 2e4);
      on(win, "online", () => {
        setNetPill("live");
        flushOutbox();
      });
      on(win, "offline", () => setNetPill("offline"));
    }
    win.__GH = {
      state: () => ({
        demo: state.demo,
        location: Object.assign({}, state.location),
        selected: Object.assign({}, state.selected),
        touched: Object.assign({}, state.touched),
        fastState: Object.assign({}, state.fastState),
        needs: Object.assign({}, state.needs),
        images: state.images.slice(),
        activeCaseCode: state.activeCaseCode
      }),
      buildPayload,
      getBandFor,
      isOutOfRange,
      submitLoop,
      addImage,
      useTypedCoordinates,
      hasUsableLocation,
      updateStatusChip,
      setAgeBand,
      openOverlay,
      closeOverlay,
      renderSettings,
      stopPolling,
      locate,
      flushOutbox,
      showView,
      env
    };
  }
  function safeStorage(win) {
    const memory = {};
    let real = null;
    try {
      real = win.localStorage;
      real.getItem("__gh_probe__");
    } catch (_) {
      real = null;
    }
    return {
      getItem(k) {
        try {
          return real ? real.getItem(k) : k in memory ? memory[k] : null;
        } catch (_) {
          return k in memory ? memory[k] : null;
        }
      },
      setItem(k, v) {
        memory[k] = String(v);
        try {
          if (real) real.setItem(k, v);
        } catch (_) {
        }
      },
      removeItem(k) {
        delete memory[k];
        try {
          if (real) real.removeItem(k);
        } catch (_) {
        }
      }
    };
  }
  class GeolocationWeb extends WebPlugin {
    constructor() {
      super();
      this.latestOrientation = null;
      if (typeof window !== "undefined") {
        const win = window;
        if ("ondeviceorientationabsolute" in win) {
          win.addEventListener("deviceorientationabsolute", (event) => this.updateOrientation(event, true), true);
        } else if ("ondeviceorientation" in win) {
          win.addEventListener("deviceorientation", (event) => this.updateOrientation(event, false), true);
        }
      }
    }
    updateOrientation(event, isAbsolute) {
      let trueHeading = null;
      let magneticHeading = null;
      let headingAccuracy = null;
      if (isAbsolute && event.alpha !== null) {
        trueHeading = (360 - event.alpha) % 360;
      } else if (event.webkitCompassHeading !== void 0 && event.webkitCompassHeading !== null) {
        magneticHeading = event.webkitCompassHeading;
        headingAccuracy = event.webkitCompassAccuracy;
      } else if (event.alpha !== null && event.absolute === true) {
        trueHeading = (360 - event.alpha) % 360;
      } else if (event.alpha !== null) {
        magneticHeading = (360 - event.alpha) % 360;
      }
      if (trueHeading !== null || magneticHeading !== null) {
        this.latestOrientation = {
          trueHeading,
          magneticHeading,
          headingAccuracy
        };
      }
    }
    augmentPosition(pos, isWatch = false) {
      var _a, _b, _c, _d, _e, _f, _g;
      const coords = pos.coords;
      const orientation = isWatch ? this.latestOrientation : null;
      const heading = (_c = (_b = (_a = orientation === null || orientation === void 0 ? void 0 : orientation.trueHeading) !== null && _a !== void 0 ? _a : orientation === null || orientation === void 0 ? void 0 : orientation.magneticHeading) !== null && _b !== void 0 ? _b : isWatch ? coords.heading : null) !== null && _c !== void 0 ? _c : null;
      return {
        timestamp: pos.timestamp,
        coords: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          altitude: coords.altitude,
          altitudeAccuracy: coords.altitudeAccuracy,
          speed: coords.speed,
          heading,
          magneticHeading: (_d = orientation === null || orientation === void 0 ? void 0 : orientation.magneticHeading) !== null && _d !== void 0 ? _d : null,
          trueHeading: (_e = orientation === null || orientation === void 0 ? void 0 : orientation.trueHeading) !== null && _e !== void 0 ? _e : null,
          headingAccuracy: (_f = orientation === null || orientation === void 0 ? void 0 : orientation.headingAccuracy) !== null && _f !== void 0 ? _f : null,
          course: (_g = isWatch ? coords.heading : null) !== null && _g !== void 0 ? _g : null
        }
      };
    }
    async getCurrentPosition(options) {
      return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition((pos) => {
          resolve(this.augmentPosition(pos, false));
        }, (err) => {
          reject(err);
        }, Object.assign({ enableHighAccuracy: false, timeout: 1e4, maximumAge: 0 }, options));
      });
    }
    async watchPosition(options, callback) {
      const id = navigator.geolocation.watchPosition((pos) => {
        callback(this.augmentPosition(pos, true));
      }, (err) => {
        callback(null, err);
      }, Object.assign({ enableHighAccuracy: false, timeout: 1e4, maximumAge: 0, minimumUpdateInterval: 5e3 }, options));
      return `${id}`;
    }
    async clearWatch(options) {
      navigator.geolocation.clearWatch(parseInt(options.id, 10));
    }
    async checkPermissions() {
      if (typeof navigator === "undefined" || !navigator.permissions) {
        throw this.unavailable("Permissions API not available in this browser");
      }
      const permission = await navigator.permissions.query({
        name: "geolocation"
      });
      return { location: permission.state, coarseLocation: permission.state };
    }
    async requestPermissions() {
      throw this.unimplemented("Not implemented on web.");
    }
  }
  const Geolocation = new GeolocationWeb();
  const web = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    Geolocation,
    GeolocationWeb
  }, Symbol.toStringTag, { value: "Module" }));
})();
