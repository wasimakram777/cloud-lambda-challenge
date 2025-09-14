import random
def lambda_handler(event, context):
    response = {"results": random.choice([True, False])}
    if response["results"]:
        response["orders"] = [{"status": "accepted", "power": 1},
                              {"status": "rejected", "power": 2}]
    return response
