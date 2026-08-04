#include "bluetooth_manager.h"
#include "config.h"
#include <NimBLEDevice.h>
#include <ArduinoJson.h>

namespace {

NimBLEServer*         server        = nullptr;
NimBLECharacteristic* targetChar    = nullptr;
NimBLECharacteristic* telemetryChar = nullptr;
NimBLECharacteristic* statusChar    = nullptr;
NimBLECharacteristic* commandChar   = nullptr;
NimBLECharacteristic* batteryChar   = nullptr;

// Boîtes aux lettres callbacks BLE (cœur 0) → loop() (cœur 1)
portMUX_TYPE bleMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool targetPending  = false;
float         targetValue    = 0.0f;
volatile bool commandPending = false;
char          commandBuf[256] = {0};

uint8_t lastBattery = 255;  // force la première mise à jour

class ServerCallbacks : public NimBLEServerCallbacks {
  // NimBLE n'appelle PAS startAdvertising() apres une connexion reussie : le
  // casque devient donc invisible des qu'un lien existe. Or Android ouvre son
  // propre lien des qu'on "jumelle" le casque dans les reglages systeme —
  // resultat, le selecteur d'appareils de Chrome ne trouve plus rien et la PWA
  // ne peut plus se connecter. On republie donc immediatement (jusqu'a
  // CONFIG_BT_NIMBLE_MAX_CONNECTIONS = 3 liens simultanes).
  void onConnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
    Serial.printf("[BLE] Client connecte : %s (liens actifs : %u)\n",
                  NimBLEAddress(desc->peer_ota_addr).toString().c_str(),
                  (unsigned)pServer->getConnectedCount());
    // Intervalle 15-30 ms : telemetrie fluide, timeout 2 s.
    pServer->updateConnParams(desc->conn_handle, 12, 24, 0, 200);
    if (pServer->getConnectedCount() < CONFIG_BT_NIMBLE_MAX_CONNECTIONS) {
      NimBLEDevice::startAdvertising();
      Serial.println(F("[BLE] Publicite maintenue (casque toujours visible)"));
    } else {
      Serial.println(F("[BLE] Liens max atteints — publicite suspendue"));
    }
  }

  void onDisconnect(NimBLEServer* pServer, ble_gap_conn_desc* desc) override {
    Serial.printf("[BLE] Client deconnecte : %s (liens restants : %u)\n",
                  NimBLEAddress(desc->peer_ota_addr).toString().c_str(),
                  (unsigned)pServer->getConnectedCount());
    NimBLEDevice::startAdvertising();
  }

  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    Serial.printf("[BLE] MTU negocie : %u octets\n", mtu);
  }
};

// Parse "90", "90.5" ou {"target":90.5} sans allocation (callback léger)
bool parseTarget(const std::string& v, float& outDeg) {
  const char* s = v.c_str();
  const char* key = strstr(s, "\"target\"");
  if (key) {
    const char* colon = strchr(key, ':');
    if (!colon) return false;
    char* end = nullptr;
    const float d = strtof(colon + 1, &end);
    if (end == colon + 1) return false;
    outDeg = d;
    return true;
  }
  char* end = nullptr;
  const float d = strtof(s, &end);
  if (end == s) return false;
  outDeg = d;
  return true;
}

class TargetCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    const std::string v = c->getValue();
    if (v.empty()) return;
    float deg;
    if (!parseTarget(v, deg)) return;
    portENTER_CRITICAL(&bleMux);
    targetValue   = deg;
    targetPending = true;
    portEXIT_CRITICAL(&bleMux);
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    const std::string v = c->getValue();
    if (v.empty() || v.length() >= sizeof(commandBuf)) return;
    portENTER_CRITICAL(&bleMux);
    memcpy(commandBuf, v.c_str(), v.length());
    commandBuf[v.length()] = '\0';
    commandPending = true;
    portEXIT_CRITICAL(&bleMux);
  }
};

}  // namespace

bool BluetoothManager::begin(const char* deviceName) {
  NimBLEDevice::init(deviceName);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);  // +9 dBm : portée maximale en forêt
  NimBLEDevice::setMTU(247);               // la télémétrie JSON dépasse les 23 octets par défaut

  // ----------------------------------------------------------------
  // Sécurité : AUCUNE. Capiq n'échange ni identifiants ni données
  // sensibles ; Web Bluetooth n'a besoin d'aucun appairage.
  //
  // Pourquoi c'est important : si l'utilisateur « jumelle » le casque
  // depuis les réglages Android, un lien chiffré (bond) est créé des
  // deux côtés. Au reflashage du firmware, la clé côté ESP32 disparaît
  // alors que le téléphone garde la sienne → toute connexion ultérieure
  // échoue au chiffrement, y compris depuis la PWA. En refusant le
  // bonding, ce blocage devient impossible.
  // ----------------------------------------------------------------
  NimBLEDevice::setSecurityAuth(false, false, false);  // pas de bonding/MITM/SC
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

  // Purge des appairages hérités d'un firmware précédent (voir ci-dessus).
  const int bonds = NimBLEDevice::getNumBonds();
  if (bonds > 0) {
    NimBLEDevice::deleteAllBonds();
    Serial.printf("[BLE] %d appairage(s) obsolete(s) efface(s) — pensez a "
                  "\"oublier\" Capiq dans les reglages Bluetooth du telephone\n", bonds);
  }

  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(CAPIQ_SERVICE_UUID);

  targetChar = svc->createCharacteristic(
      CAPIQ_CHAR_TARGET_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  targetChar->setCallbacks(new TargetCallbacks());

  telemetryChar = svc->createCharacteristic(
      CAPIQ_CHAR_TELEMETRY_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  statusChar = svc->createCharacteristic(
      CAPIQ_CHAR_STATUS_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  commandChar = svc->createCharacteristic(
      CAPIQ_CHAR_COMMAND_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  commandChar->setCallbacks(new CommandCallbacks());

  svc->start();

  // Service standard Battery (0x180F / 0x2A19) : lisible par n'importe quel
  // outil BLE, en plus du champ "battery" de la télémétrie.
  NimBLEService* battSvc = server->createService(NimBLEUUID((uint16_t)0x180F));
  batteryChar = battSvc->createCharacteristic(
      NimBLEUUID((uint16_t)0x2A19),
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  battSvc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  // Web Bluetooth est plus fiable quand le nom complet est dans le paquet
  // d'advertising principal (pas uniquement en scan response).
  // Budget : 3 (flags) + 18 (UUID 128 bits) + 2 + strlen(nom) <= 31 octets,
  // soit 8 caracteres maximum pour le nom. Au-dela, NimBLE le tronque.
  adv->setName(deviceName);
  adv->addServiceUUID(CAPIQ_SERVICE_UUID);
  adv->setScanResponse(false);

  if (!adv->start()) {
    Serial.println(F("[BLE] ECHEC du demarrage de la publicite !"));
    return false;
  }

  Serial.printf("[BLE] Serveur '%s' demarre, publicite active (sans appairage)\n", deviceName);
  return true;
}

void BluetoothManager::forgetBonds() {
  const int n = NimBLEDevice::getNumBonds();
  NimBLEDevice::deleteAllBonds();
  Serial.printf("[BLE] %d appairage(s) efface(s) cote casque.\n", n);
}

void BluetoothManager::restartAdvertising() {
  NimBLEDevice::startAdvertising();
  Serial.println(F("[BLE] Publicite relancee."));
}

bool BluetoothManager::isConnected() const {
  return server && server->getConnectedCount() > 0;
}

bool BluetoothManager::fetchTargetAzimuth(float& outDeg) {
  bool has = false;
  portENTER_CRITICAL(&bleMux);
  if (targetPending) {
    outDeg        = targetValue;
    targetPending = false;
    has           = true;
  }
  portEXIT_CRITICAL(&bleMux);
  return has;
}

bool BluetoothManager::fetchCommand(String& outJson) {
  char local[sizeof(commandBuf)];
  bool has = false;
  portENTER_CRITICAL(&bleMux);
  if (commandPending) {
    strncpy(local, commandBuf, sizeof(local));
    local[sizeof(local) - 1] = '\0';
    commandPending = false;
    has            = true;
  }
  portEXIT_CRITICAL(&bleMux);
  if (has) outJson = local;
  return has;
}

void BluetoothManager::notifyTelemetry(const TelemetryPacket& t) {
  if (!telemetryChar) return;

  JsonDocument doc;
  if (t.hasTarget) {
    doc["target"] = roundf(t.target * 10) / 10;
    doc["error"]  = roundf(t.error * 10) / 10;
  } else {
    doc["target"] = nullptr;
    doc["error"]  = nullptr;
  }
  doc["heading"] = roundf(t.heading * 10) / 10;
  doc["battery"] = t.battery;
  doc["pitch"]   = roundf(t.pitch * 10) / 10;
  doc["roll"]    = roundf(t.roll * 10) / 10;

  char buf[192];
  const size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n == 0) return;

  telemetryChar->setValue((uint8_t*)buf, n);
  if (isConnected()) telemetryChar->notify();
}

void BluetoothManager::setStatus(const String& json) {
  if (!statusChar) return;
  statusChar->setValue((uint8_t*)json.c_str(), json.length());
  if (isConnected()) statusChar->notify();
}

void BluetoothManager::setBatteryLevel(uint8_t percent) {
  if (!batteryChar || percent == lastBattery) return;
  lastBattery = percent;
  batteryChar->setValue(&percent, 1);
  if (isConnected()) batteryChar->notify();
}
