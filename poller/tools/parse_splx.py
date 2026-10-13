#!/usr/bin/env python3
"""
Estrae l'anagrafica dei dispositivi da un progetto powerconfig (.splx).

Il .splx e' uno zip: una cartella per dispositivo sotto ProjectItems/,
con Properties.xml (configurazione) e CommunicationParameter.xml
(parametri di connessione). Qui si tirano fuori solo i campi che
servono al poller, piu' quelli che vanno controllati prima di partire.
"""
import csv
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/splx')

# Campi di Properties.xml che interessano.
WANTED = [
    'Name', 'DeviceType', 'Description', 'Firmware', 'Variant',
    'PlantIdentifier', 'LocationIdentifier', 'Comment',
    'IPAddress', 'Port', 'SubnetMask', 'Gateway', 'DHCP', 'MACAddress',
    'ConnectionType', 'UseVoltageTransformer',
    'MeasuredVoltage', 'PrimaryVoltage', 'SecondaryVoltage',
    'PrimaryCurrent', 'SecondaryCurrent',
    'PasswordProtection', 'SubnetFirewallProtection',
    'DemandTimeInterval', 'TimeZone',
]


def parse_properties(path):
    """Properties.xml -> dict piatto {nome_proprieta: valore}."""
    out = {}
    root = ET.parse(path).getroot()
    out['_typeId'] = root.get('typeId')
    for prop in root.iter('Property'):
        name = prop.get('n')
        if name in WANTED:
            out[name] = (prop.text or '').strip()
    return out


def parse_comm(path):
    """CommunicationParameter.xml -> parametri di connessione."""
    out = {}
    root = ET.parse(path).getroot()

    def txt(tag, parent=root):
        el = parent.find(tag)
        return (el.text or '').strip() if el is not None and el.text else ''

    out['ModbusAddress'] = txt('ModbusAddress')
    out['PCInterface'] = txt('PCInterface')
    out['CommFirmware'] = txt('Firmware')
    tcp = root.find('Tcp')
    if tcp is not None:
        out['HostAddress'] = txt('HostAddress', tcp)
        out['TcpPort'] = txt('Port', tcp)
        out['TcpProtocol'] = txt('Protocol', tcp)
        out['TcpGateway'] = txt('Gateway', tcp)
        out['TcpSubnet'] = txt('SubnetMask', tcp)
    return out


def main():
    devices = []
    for item in sorted((ROOT / 'ProjectItems').iterdir()):
        props_f = item / 'Properties.xml'
        comm_f = item / 'CommunicationParameter.xml'
        if not props_f.exists():
            continue
        p = parse_properties(props_f)
        # Il nodo radice del progetto non ha DeviceType: si scarta.
        if not p.get('DeviceType'):
            print(f"# saltato (nodo non dispositivo): {item.name} "
                  f"typeId={p.get('_typeId')} name={p.get('Name')!r}")
            continue
        if comm_f.exists():
            p.update(parse_comm(comm_f))
        p['_uuid'] = item.name
        devices.append(p)

    devices.sort(key=lambda d: d.get('Name', ''))

    out = ROOT.parent / 'devices-parsed.csv'
    cols = ['Name', 'DeviceType', 'Variant', 'Firmware', 'IPAddress',
            'Port', 'TcpPort', 'ModbusAddress', 'TcpProtocol', 'PCInterface',
            'SubnetMask', 'Gateway', 'DHCP', 'MACAddress',
            'ConnectionType', 'UseVoltageTransformer',
            'MeasuredVoltage', 'PrimaryVoltage', 'SecondaryVoltage',
            'PrimaryCurrent', 'SecondaryCurrent',
            'PlantIdentifier', 'LocationIdentifier', 'Description', 'Comment',
            'PasswordProtection', 'SubnetFirewallProtection',
            'DemandTimeInterval', '_uuid']
    with out.open('w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        for d in devices:
            w.writerow(d)

    print(f"\n{len(devices)} dispositivi -> {out}")
    return devices


if __name__ == '__main__':
    main()
