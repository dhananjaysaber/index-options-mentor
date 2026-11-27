"""Server-owned amount sizing. All readers are injected; no browser quote is trusted."""
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR
import re
import time

# Owner decision 27 Nov 2026: real orders are limited to 2 lots, with one buy
# open at a time. This limits size only; it does not choose or exit trades.
# There is deliberately no setting or request that can raise it.
MAX_LOTS = 2


def decimal(value):
    try:
        if isinstance(value,bool): raise ValueError('INVALID_NUMBER')
        number = Decimal(str(value))
        if not number.is_finite(): raise ValueError('INVALID_NUMBER')
        return number
    except InvalidOperation as error:
        raise ValueError('INVALID_NUMBER') from error


class EntryPlanner:
    def __init__(self, contracts, quotes, market_open, max_amount=0, fee_reserve=0, clock=time.time):
        self.contracts,self.quotes,self.market_open = contracts,quotes,market_open
        self.max_amount,self.fee_reserve,self.clock = decimal(max_amount),decimal(fee_reserve),clock
        if self.fee_reserve < 0: raise ValueError('INVALID_FEE_RESERVE')

    def quote(self, symbol):
        quote = self.quotes(symbol)
        now = self.clock()
        at = decimal(quote.get('at'))
        ask = decimal(quote.get('ask'))
        if quote.get('symbol') != symbol or not Decimal('-1') <= decimal(now)-at <= 3 or ask <= 0:
            raise ValueError('STALE_OR_INVALID_OPTION_QUOTE')
        return ask

    def plan(self, symbol, amount, available_funds):
        if self.market_open() is not True: raise ValueError('ENTRY_SESSION_CLOSED')
        plan = self.size(symbol, amount)
        self.check_funds(available_funds,plan['premiumCost'])
        return plan

    def size(self, symbol, amount):
        """Price and lots for an amount. Reads contract and quote only."""
        if not isinstance(symbol,str) or not re.fullmatch(r'NSE:NIFTY[A-Z0-9]+(?:CE|PE)',symbol):
            raise ValueError('INVALID_NIFTY_CONTRACT')
        amount = decimal(amount).quantize(Decimal('.01'),rounding=ROUND_FLOOR)
        if amount <= 0 or amount > self.max_amount: raise ValueError('AMOUNT_LIMIT_NOT_SET_OR_EXCEEDED')
        contract = self.validate_contract(symbol)
        units,freeze = contract['lot_size'],contract['max_quantity']
        tick = decimal(contract['tick_size'])
        ask = self.quote(symbol)
        limit = (ask/tick).to_integral_value(rounding=ROUND_CEILING)*tick
        lots = min(int(amount//(limit*units)),MAX_LOTS)
        qty = lots*units
        if qty < units: raise ValueError('AMOUNT_CANNOT_BUY_ONE_LOT')
        if qty > freeze: raise ValueError('EXCHANGE_QUANTITY_LIMIT')
        premium = limit*qty
        return {'amount':float(amount),'lots':lots,'lotSize':units,'buyPrice':float(limit),
                'premiumCost':float(premium),'feeReserve':float(self.fee_reserve),
                'payload':{'symbol':symbol,'qty':qty,'side':1,'type':1,'limitPrice':float(limit),
                           'productType':'INTRADAY','validity':'DAY','offlineOrder':False,
                           'stopPrice':0,'disclosedQty':0,'isSliceOrder':False}}

    def validate_contract(self, symbol):
        contract = self.contracts(symbol)
        units,freeze = contract.get('lot_size'),contract.get('max_quantity')
        now = decimal(self.clock())
        if (contract.get('symbol') != symbol or contract.get('active') is not True or
                type(units) is not int or units <= 0 or type(freeze) is not int or freeze < units or
                not Decimal('-30') <= now-decimal(contract.get('checked_at')) <= 86400 or
                decimal(contract.get('expires_at')) <= now):
            raise ValueError('STALE_OR_INVALID_CONTRACT')
        tick = decimal(contract.get('tick_size'))
        if tick <= 0: raise ValueError('INVALID_TICK_SIZE')
        return contract

    def check_funds(self, available, premium):
        if decimal(available) < decimal(premium)+self.fee_reserve:
            raise ValueError('INSUFFICIENT_AVAILABLE_FUNDS')
