import json, os, datetime
import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["LOG_BUCKET"]

def lambda_handler(event, context):
    """
    Event shape from Step Functions Map item:
      { "status": "accepted"|"rejected", "power": <number> }
    accepted  -> write JSON to s3://$LOG_BUCKET/orders/...
    rejected  -> raise to trigger SNS via the Map's catch
    """
    status = event.get("status")
    power = event.get("power")

    if status == "rejected":
        raise ValueError(f"Order rejected: power={power}")

    now = datetime.datetime.utcnow().isoformat()
    key = f"orders/order_{now}.json"
    body = json.dumps({"status": status, "power": power, "ts": now})
    s3.put_object(Bucket=BUCKET, Key=key, Body=body.encode("utf-8"))
    return {"ok": True, "key": key}
