"""Narrow adapter for an injected official synchronous FYERS SDK client.

Constructing this class never reads credentials or sends orders. Trading requires
both the coordinator and this adapter to be explicitly enabled by a future host.
"""
import math


class FyersBroker:
    def __init__(self, client, send_enabled=False):
        self.client, self.send_enabled = client, send_enabled

    @staticmethod
    def _ok(result):
        if not isinstance(result, dict) or result.get('s') != 'ok':
            # Never propagate broker payloads containing private account details.
            raise ValueError('FYERS_READ_FAILED')
        return result

    def account_id(self):
        data = self._ok(self.client.get_profile()).get('data')
        owner = data.get('fy_id') if isinstance(data, dict) else None
        if not isinstance(owner,str) or not owner:
            raise ValueError('FYERS_PROFILE_INVALID')
        return owner

    def available_funds(self):
        rows = self._ok(self.client.funds()).get('fund_limit')
        if not isinstance(rows,list): raise ValueError('FYERS_FUNDS_INVALID')
        matches = [r for r in rows if isinstance(r,dict) and r.get('id') == 10]
        value = matches[0].get('equityAmount') if len(matches) == 1 else None
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value < 0:
            raise ValueError('FYERS_FUNDS_INVALID')
        return value

    def orders_by_tag(self, tag):
        rows = self._ok(self.client.orderbook()).get('orderBook')
        if not isinstance(rows,list) or any(not isinstance(r,dict) for r in rows):
            raise ValueError('FYERS_ORDERBOOK_INVALID')
        return [row for row in rows if row.get('orderTag') == tag]

    def net_quantity(self, symbol):
        rows = self._ok(self.client.positions()).get('netPositions')
        if not isinstance(rows,list): raise ValueError('FYERS_POSITIONS_INVALID')
        qty = 0
        for row in rows:
            if not isinstance(row,dict): raise ValueError('FYERS_POSITIONS_INVALID')
            if row.get('symbol') == symbol and row.get('productType') == 'INTRADAY':
                value = row.get('netQty')
                if type(value) is not int: raise ValueError('FYERS_POSITIONS_INVALID')
                qty += value
        return qty

    def place_order(self, payload):
        if self.send_enabled is not True:
            raise ValueError('FYERS_SEND_DISABLED')
        return self.client.place_order(data=dict(payload))

    def cancel_order(self, order_id):
        if self.send_enabled is not True: raise ValueError('FYERS_SEND_DISABLED')
        return self.client.cancel_order(data={'id':order_id})

    def modify_stop(self, order_id, stop_price, limit_price, quantity):
        if self.send_enabled is not True: raise ValueError('FYERS_SEND_DISABLED')
        return self.client.modify_order(data={'id':order_id,'type':4,'stopPrice':stop_price,
                                             'limitPrice':limit_price,'qty':quantity})
