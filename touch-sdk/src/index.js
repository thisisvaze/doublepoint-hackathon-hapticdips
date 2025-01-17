import { Update, InputUpdate, Info } from './watch_protobuf.js'
import { UAParser } from 'ua-parser-js'

const serviceUuids = {
    INTERACTION: '008e74d0-7bb3-4ac5-8baf-e5e372cced76',
    PROTOBUF: 'f9d60370-5325-4c64-b874-a68c7c555bad'
}

const characteristicUuids = {
    PROTOBUF_OUTPUT: 'f9d60371-5325-4c64-b874-a68c7c555bad',
    PROTOBUF_INPUT: 'f9d60372-5325-4c64-b874-a68c7c555bad',
    PROTOBUF_INFO: 'f9d60373-5325-4c64-b874-a68c7c555bad'
}

const handedness = [
    "none",
    "right",
    "left"
]

export class Watch extends EventTarget {
    constructor() {
        super()
        this._accepted = false

        this._hand = handedness[0]

        this._hapticsAvailable = false
        this._touchScreenResolution = {width: 0, height: 0}
        this._batteryPercentage = -1

        this._appId = ''
        this._appVersion = ''
        this._manufacturer = ''
        this._deviceName = ''
        this._modelInfo = ''
    }

    createConnectButton = () => {
        const button = document.createElement('button')
        button.innerText = 'Connect Touch SDK Controller'
        button.classList.add('touch-sdk-connect-button')

        button.addEventListener('click', () => {
            this.requestConnection()
            .catch(error => alert(error.message))
        })

        this.addEventListener('device-selected', () => {
            button.style.display = 'none'
        })

        this.addEventListener('disconnected', () => {
            button.style.display = 'inline-block' // default display style for a button
        })

        return button
    }

    requestConnection = async () => {
        if (!navigator.bluetooth) {
            let errorMessage
            if (navigator.userAgent.indexOf('Chrome') !== -1) {
                // Browser probably supports Web Bluetooth, but it is not enabled.
                errorMessage = 'Web Bluetooth is disabled. Please enable it from chrome://flags'
            } else {
                errorMessage = 'Web Bluetooth is not available, and likely not supported' +
                               ' on your browser. Please try a Chrome-based browser.'
            }
            return Promise.reject(new Error(errorMessage))
        }

        const filters = [{ services: [serviceUuids.INTERACTION]}]
        const optionalServices = [
            serviceUuids.PROTOBUF
        ]

        return navigator.bluetooth.requestDevice({ filters, optionalServices })
        .then(device => {
            this._device = device

            this.device.addEventListener('gattserverdisconnected', () => {
                const event = new CustomEvent('disconnected')
                this.dispatchEvent(event)
            })

            this.device.gatt.connect()
            .then(gattServer => {
                // The watch receives a connection request, but might not accept it
                const event = new CustomEvent('device-selected')
                this.dispatchEvent(event)
                this._gattServer = gattServer
                this._sendClientInfo()
                this._subscribeToNotifications()
            })
            return this
        })
    }

    disconnect = () => {
        this.device.gatt.disconnect()
    }

    _subscribeToNotifications = () => {
        this.gattServer.getPrimaryService(serviceUuids.PROTOBUF).then(service => {
            service.getCharacteristic(characteristicUuids.PROTOBUF_OUTPUT).then(characteristic => {
                characteristic.addEventListener('characteristicvaluechanged', gattEvent => {
                    const dataView = gattEvent.target.value
                    const uints = new Uint8Array(dataView.buffer)
                    const messageObject = Update.decode(uints)

                    this._dispatchProtobufEvents(messageObject)

                })
                characteristic.startNotifications()
            })
        })
    }

    _dispatchProtobufEvents = (message) => {
        for (const gesture of message.gestures) {
            if (gesture.type === 1) {
                this.dispatchEvent(new CustomEvent('tap'))
            }
            if (gesture.type === 3) {
                this.dispatchEvent(new CustomEvent('surface_tap'))
            }
        }

        for (const prob of message.probabilities) {
            let gestureProb = 0
            if (prob.label === 0) {
                gestureProb = 1 - prob.probability
            } else {
                gestureProb = prob.probability
            }
            this.dispatchEvent(new CustomEvent('probability', {detail: gestureProb}))
        }

        for (const rotaryEvent of message.rotaryEvents) {
            this.dispatchEvent(new CustomEvent('rotary', {detail: rotaryEvent.step}))
        }

        for (const touchEvent of message.touchEvents) {
            // if type is none of the known ones, eventName will be undefined
            const eventName = ({
                1: 'touchstart',
                2: 'touchend',
                3: 'touchmove',
                4: 'touchcancel'
            })[touchEvent.type]

            if (eventName)
                this.dispatchEvent(new CustomEvent(eventName, {detail: touchEvent.coords}))
        }

        for (const buttonEvent of message.buttonEvents) {
            this.dispatchEvent(new CustomEvent('button', {detail: buttonEvent.id}))
        }

        for (const frame of message.sensorFrames) {
            this.dispatchEvent(new CustomEvent('accelerationchanged', {detail: frame.acc}))
            this.dispatchEvent(new CustomEvent('gravityvectorchanged', {detail: frame.grav}))
            this.dispatchEvent(new CustomEvent('angularvelocitychanged', {detail: frame.gyro}))
            this.dispatchEvent(new CustomEvent('orientationchanged', {detail: frame.quat}))
            this.dispatchRayCasting(frame)
        }

        if (message.info) {
            this._parseInfo(message.info)
        }

        if (message.signals.includes(1)) {
            this.gattServer.disconnect()
        } else if (!this._accepted) {
            this._fetchInfo()
            this._accepted = true
        }

    }

    _sendClientInfo = () => {
        this.gattServer.getPrimaryService(serviceUuids.PROTOBUF).then(service => {
            service.getCharacteristic(characteristicUuids.PROTOBUF_INPUT).then(characteristic => {
                const parser = new UAParser()
                parser.setUA(navigator.userAgent)
                const result = parser.getResult()
                const browser = result.browser

                const inputUpdate = InputUpdate.create(
                    {clientInfo: {
                        // file:// URLs don't have a window.location.host, use filename instead
                        appName: window.location.host || window.location.pathname.split('/').pop(),
                        deviceName: `${browser.name}`,
                        os: result.os.name
                    }}
                )

                const data = InputUpdate.encode(inputUpdate).finish()
                const dataView = new DataView(data.buffer.slice(0, data.length))

                characteristic.writeValueWithResponse(dataView)
            })
        })
    }

    _parseInfo = (info) => {

        const handRaw = info.hand

        if (handRaw >= 0 && handRaw < handedness.length) {
            const hand = handedness[handRaw]
            if (hand !== this.hand) {
                this._hand = hand
                this.dispatchEvent(
                    new CustomEvent('handednesschanged', {detail: hand})
                )
            }
        }

        if (info.hapticsAvailable) {
            this._hapticsAvailable = true
        }

        if (info.touchScreenResolution && info.touchScreenResolution.x > 0 && info.touchScreenResolution.y > 0) {
            this._touchScreenResolution = {width: info.touchScreenResolution.x, height: info.touchScreenResolution.y}
        }

        if (info.batteryPercentage > 0 && info.batteryPercentage <= 100) {
            this._batteryPercentage = info.batteryPercentage
        }

        if (info.appId) {
            this._appId = info.appId
        }

        if (info.appVersion) {
            this._appVersion = info.appVersion
        }

        if (info.manufacturer) {
            this._manufacturer = info.manufacturer
        }

        if (info.deviceName) {
            this._deviceName = info.deviceName
        }

        if (info.modelInfo) {
            this._modelInfo = info.modelInfo
        }
    }

    _fetchInfo = () => {
        this.gattServer.getPrimaryService(serviceUuids.PROTOBUF).then(service => {
            service.getCharacteristic(characteristicUuids.PROTOBUF_OUTPUT).then(characteristic => {
                characteristic.readValue().then(data => {
                    const uints = new Uint8Array(data.buffer)
                    const info = Update.decode(uints).info
                    this._parseInfo(info)
                    this.dispatchEvent(new CustomEvent('connected'))
                })
            })
        })
    }

    dispatchRayCasting = (frame) => {
        const scaling = 1
        const acceleration = 0

        // Assumes right hand if this.hand === 'none'
        const handednessScale = this.hand === 'left' ? -1 : 1

        const { x, y, z } = frame.grav
        const r = Math.sqrt(x*x + y*y + z*z)
        const gravityDirection = {
            x: x/r,
            y: y/r,
            z: z/r
        }
        const vx = -frame.gyro.z // right = +
        const vy = -frame.gyro.y // down = +

        const vr = Math.sqrt(vx*vx + vy*vy)

        const dx = scaling * vx * Math.pow(vr, acceleration)
        const dy = scaling * vy * Math.pow(vr, acceleration)

        const rayX = dx * gravityDirection.z + dy * gravityDirection.y
        const rayY = handednessScale * (dy * gravityDirection.z - dx * gravityDirection.y)

        this.dispatchEvent(new CustomEvent('armdirectionchanged', {detail:
            {
                dx: rayX,
                dy: rayY
            }
        }))

        // raycasting delta
        // ray angle speed
        // wrist pointing direction
        // raycast move
    }

    triggerHaptics = (intensity, length) => {
        const saneLength = Math.max(Math.min(length, 5000), 0)
        const saneIntensity = Math.max(Math.min(intensity, 1.0), 0.0)

        this.gattServer.getPrimaryService(serviceUuids.PROTOBUF).then(service => {
            service.getCharacteristic(characteristicUuids.PROTOBUF_INPUT).then(characteristic => {

                const inputUpdate = InputUpdate.create(
                    {hapticEvent: {type: 1, intensity: saneIntensity, length: saneLength}}
                )

                const data = InputUpdate.encode(inputUpdate).finish()
                const dataView = new DataView(data.buffer.slice(0, data.length))

                characteristic.writeValueWithResponse(dataView)
            })
        })

    }

    get device() { return this._device }
    get gattServer() { return this._gattServer }
    get hand() { return this._hand }
    get hapticsAvailable() { return this._hapticsAvailable }
    get touchScreenResolution() { return this._touchScreenResolution }
    get batteryPercentage() { return this._batteryPercentage }
    get appId() { return this._appId }
    get appVersion() { return this._appVersion }
    get manufacturer() { return this._manufacturer }
    get deviceName() { return this._deviceName }
    get modelInfo() { return this._modelInfo }

}
