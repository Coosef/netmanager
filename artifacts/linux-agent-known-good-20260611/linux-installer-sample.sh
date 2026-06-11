        #!/bin/bash
        # NetManager Proxy Agent — Linux/macOS Installer
        # Generated: 2026-06-11 09:22 UTC
        # Agent ID: known-good-fake-id

        set -e

        AGENT_ID=known-good-fake-id
        AGENT_KEY=REDACTED_FAKE_KEY
        BACKEND_URL=https://netmanager.systrack.app
        SERVICE_NAME="netmanager-agent"

        OS_TYPE="$(uname -s)"

        if [ "$OS_TYPE" = "Darwin" ]; then
            if [ "$EUID" -eq 0 ]; then
                INSTALL_DIR="/opt/netmanager-agent"
            else
                INSTALL_DIR="$HOME/.netmanager-agent"
            fi
            RUN_AS_ROOT=0
        else
            INSTALL_DIR="/opt/netmanager-agent"
            RUN_AS_ROOT=1
            if [ "$EUID" -ne 0 ]; then
                echo "Linux: Lütfen root olarak çalıştırın: sudo bash $(basename "$0")"
                exit 1
            fi
        fi

        echo "[1/5] Python ve bağımlılıklar kontrol ediliyor..."
        if ! command -v python3 &>/dev/null; then
            if [ "$OS_TYPE" = "Darwin" ]; then
                command -v brew &>/dev/null && brew install python3 || {
                    echo "Python3 bulunamadı."; exit 1
                }
            elif command -v apt-get &>/dev/null; then
                apt-get install -y python3 python3-venv python3-full curl
            elif command -v yum &>/dev/null; then
                yum install -y python3 python3-pip curl
            else
                echo "Python3 bulunamadı. Lütfen manuel kurun."; exit 1
            fi
        fi
        # Debian/Ubuntu: python3-venv gerekli
        if [ "$OS_TYPE" != "Darwin" ] && command -v apt-get &>/dev/null; then
            apt-get install -y python3-venv python3-full curl 2>/dev/null || true
        fi
        SYS_PYTHON="$(which python3)"

        echo "[2/5] Kurulum dizini ve sanal ortam hazırlanıyor..."
        mkdir -p "$INSTALL_DIR"
        VENV_DIR="$INSTALL_DIR/venv"
        if [ ! -d "$VENV_DIR" ]; then
            $SYS_PYTHON -m venv "$VENV_DIR"
        fi
        PYTHON="$VENV_DIR/bin/python"

        echo "[3/5] Agent betiği indiriliyor..."
        # T8.4 F3 — /download/script artık X-Agent-ID + X-Agent-Key
        # header'ları zorunlu (anonim erişim CWE-200 LOW kapatıldı).
        # Eski fallback (anonim) bilinçli olarak kaldırıldı.
        curl -fsSL           -H "X-Agent-ID: $AGENT_ID"           -H "X-Agent-Key: $AGENT_KEY"           "$BACKEND_URL/api/v1/agents/download/script"           -o "$INSTALL_DIR/netmanager_agent.py"

        echo "[4/5] Bağımlılıklar kuruluyor (venv)..."
        $PYTHON -m pip install --quiet --no-cache-dir --upgrade pip
        $PYTHON -m pip install --quiet --no-cache-dir websockets netmiko psutil

        ENV_FILE="$INSTALL_DIR/agent.env"
        cat > "$ENV_FILE" <<ENVEOF
NETMANAGER_URL=https://netmanager.systrack.app
NETMANAGER_AGENT_ID=known-good-fake-id
NETMANAGER_AGENT_KEY=REDACTED_FAKE_KEY
ENVEOF
        chmod 600 "$ENV_FILE"

        echo "[5/5] Servis kuruluyor..."
        if [ "$OS_TYPE" = "Darwin" ]; then
            if [ "$EUID" -eq 0 ]; then
                PLIST_DIR="/Library/LaunchDaemons"
            else
                PLIST_DIR="$HOME/Library/LaunchAgents"
                mkdir -p "$PLIST_DIR"
            fi
            PLIST_PATH="$PLIST_DIR/com.netmanager.agent.plist"
            cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.netmanager.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$INSTALL_DIR/netmanager_agent.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NETMANAGER_URL</key><string>https://netmanager.systrack.app</string>
        <key>NETMANAGER_AGENT_ID</key><string>known-good-fake-id</string>
        <key>NETMANAGER_AGENT_KEY</key><string>REDACTED_FAKE_KEY</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$INSTALL_DIR/agent.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/agent.log</string>
</dict>
</plist>
PLISTEOF
            chmod 644 "$PLIST_PATH"
            if [ "$EUID" -eq 0 ]; then
                launchctl bootout system/com.netmanager.agent 2>/dev/null || true
                launchctl bootout system "$PLIST_PATH" 2>/dev/null || true
                launchctl bootstrap system "$PLIST_PATH" 2>/dev/null ||                     launchctl load -w "$PLIST_PATH" 2>/dev/null || true
            else
                launchctl unload "$PLIST_PATH" 2>/dev/null || true
                launchctl load -w "$PLIST_PATH"
            fi
            sleep 1
            if launchctl list 2>/dev/null | grep -q com.netmanager.agent; then
                echo "✓ NetManager Agent kuruldu ve başlatıldı! (macOS launchd)"
            else
                echo "⚠ Plist yüklendi ancak servis başlamadı. Manuel başlatın:"
                echo "  sudo launchctl load -w $PLIST_PATH"
            fi
        else
            cat > /etc/systemd/system/$SERVICE_NAME.service <<SVCEOF
[Unit]
Description=NetManager Proxy Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=$ENV_FILE
ExecStart=$PYTHON $INSTALL_DIR/netmanager_agent.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF
            systemctl daemon-reload
            systemctl enable $SERVICE_NAME
            systemctl restart $SERVICE_NAME
            echo "✓ NetManager Agent kuruldu! (Linux systemd, venv: $VENV_DIR)"
        fi
