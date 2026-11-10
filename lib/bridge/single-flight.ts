export function runSingleFlight<K, V>(flights: Map<K, Promise<V>>, key: K, task: () => Promise<V>) {
  const existing = flights.get(key);
  if (existing) return existing;
  const flight = task();
  flights.set(key, flight);
  void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => undefined);
  return flight;
}
