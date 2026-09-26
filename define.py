class define:
    author = "Wakaura"
    logger_name = "RemoteServerUpload"

    _settings: dict = {
        # Connection defaults (pre-fill new node widgets)
        "default_address": "192.168.1.100",
        "default_port": 8765,
        # Credential defaults (HTTP Basic Auth)
        "default_use_credentials": False,
        "default_username": "",
        "default_password": "",
        "save_password_in_workflow": True,
        # Timeout tuning
        "health_connect_timeout": 5.0,
        "assumed_bandwidth_mbps": 5.0,
        "safety_multiplier": 3.0,
        "min_timeout": 30.0,
    }