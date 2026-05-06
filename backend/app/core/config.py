from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # App
    APP_NAME: str = "NetManager"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False

    # Database
    DATABASE_URL: str
    SYNC_DATABASE_URL: str

    # Redis / Celery
    REDIS_URL: str = "redis://redis:6379/0"

    # Security
    SECRET_KEY: str
    CREDENTIAL_ENCRYPTION_KEY: str
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    ALGORITHM: str = "HS256"

    # CORS
    ALLOWED_ORIGINS: str = "http://localhost:3000"

    # SSH
    SSH_MAX_CONCURRENT: int = 50
    SSH_CONNECT_TIMEOUT: int = 30
    SSH_COMMAND_TIMEOUT: int = 60

    # AI / LLM
    ANTHROPIC_API_KEY: str = ""

    # Agent WebSocket URL override — set this to the direct (non-Cloudflare) URL
    # so installer scripts embed the correct WebSocket endpoint.
    # Example: https://ws.systrack.app
    AGENT_WS_URL: str = ""

    @property
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
