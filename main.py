import os
import json
import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from google.oauth2 import service_account
from google.auth.transport.requests import Request as GoogleRequest

app = FastAPI()

PROJECT_ID = os.getenv("PROJECT_ID")
REGION = "global"

VERTEX_URL = f"https://aiplatform.googleapis.com/v1beta1/projects/{PROJECT_ID}/locations/{REGION}/endpoints/openapi/chat/completions"

# Load service account from env (Render)
SERVICE_ACCOUNT_INFO = json.loads(os.getenv("GOOGLE_CREDENTIALS"))

credentials = service_account.Credentials.from_service_account_info(
    SERVICE_ACCOUNT_INFO,
    scopes=["https://www.googleapis.com/auth/cloud-platform"]
)

def get_access_token():
    credentials.refresh(GoogleRequest())
    return credentials.token

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()

    token = get_access_token()

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }

    # Forward entire request (model stays dynamic)
    resp = requests.post(VERTEX_URL, headers=headers, json=body, stream=body.get("stream", False))

    if body.get("stream"):
        def stream():
            for chunk in resp.iter_content(chunk_size=1024):
                if chunk:
                    yield chunk
        return StreamingResponse(stream(), media_type="text/event-stream")

    return JSONResponse(resp.json(), status_code=resp.status_code)
